/**
 * rp2040js's peripheral classes on the RP2350 (BT66) — the blocks whose register maps the two
 * chips share (RP2350 datasheet against the RP2040's, checked register by register in the
 * pico-sdk headers): DW_apb_i2c (`RPI2C`), the USB controller (`RPUSBController`; the RP2350's
 * additions past the RP2040's last register are reported as unmodelled), and PIO (`RPPIO`;
 * PIO v1's RXF_PUTGET and GPIOBASE sit where the RP2040 has INTR…IRQ1_INTS, which moved up by
 * 0x44 — `RpjsBlock` remaps them; v1's new instruction encodings aren't decoded).
 *
 * `RpjsHost` is the slice of rp2040js's RP2040 object those classes use: the clock (nanoseconds
 * and alarms, on the SoC's clock), `setInterrupt` (the RP2040's USB IRQ 5 is the RP2350's 14;
 * the others are constructed with RP2350 numbers), clk_sys/clk_peri, DMA DREQs (no DMA yet: they
 * go nowhere), the USB DPRAM (the SoC's), a logger (warnings become `rp2350-unimplemented`) and
 * GPIO stand-ins: PIO reads each pin's input and tells the SoC when its outputs change.
 */

import type { Peripheral, RP2040 } from 'rp2040js';
import { applyAlias, Periph, type PeriphHost } from './block.ts';

/** RP2040 USBCTRL_IRQ → RP2350 USBCTRL_IRQ. */
const RP2040_USB_IRQ = 5;
const RP2350_USB_IRQ = 14;

export interface RpjsSoc {
  now(): number;
  alarm(callback: () => void): { scheduleAt(atNanos: number): void; cancel(): void };
  setIrq(irq: number, level: boolean): void;
  sysHz(): number;
  periHz(): number;
  dpram: Uint8Array;
  /** A pin's input level (0/1). */
  input(n: number): number;
  /** A peripheral's pin outputs changed. */
  pinsChanged(): void;
  warn(component: string, message: string): void;
}

/** The parts of rp2040js's `RP2040` its peripheral classes touch, over the RP2350 SoC. */
export function rpjsHost(soc: RpjsSoc): RP2040 {
  const gpio = Array.from({ length: 30 }, (_, n) => ({
    get inputValue(): boolean {
      return soc.input(n) !== 0;
    },
    checkForUpdates(): void {
      soc.pinsChanged();
    },
  }));
  const host = {
    clock: {
      get nanos(): number {
        return soc.now();
      },
      createAlarm(callback: () => void) {
        const alarm = soc.alarm(callback);
        return {
          schedule: (deltaNanos: number) => alarm.scheduleAt(soc.now() + Math.max(0, deltaNanos)),
          cancel: () => alarm.cancel(),
        };
      },
    },
    get clkSys(): number {
      return soc.sysHz();
    },
    get clkPeri(): number {
      return soc.periHz();
    },
    setInterrupt(irq: number, value: boolean): void {
      soc.setIrq(irq === RP2040_USB_IRQ ? RP2350_USB_IRQ : irq, value);
    },
    dma: { setDREQ: () => {}, clearDREQ: () => {} },
    usbDPRAM: soc.dpram,
    usbDPRAMView: new DataView(soc.dpram.buffer, soc.dpram.byteOffset, soc.dpram.byteLength),
    gpio,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (component: string, message: string) => soc.warn(component, message),
      error: (component: string, message: string) => soc.warn(component, message),
    },
  };
  return host as unknown as RP2040;
}

/** PIO v1 registers past the RP2040's: RP2350 offset → the RP2040 offset rp2040js serves (−1: not modelled). */
function pioOffset(offset: number): number {
  if (offset < 0x128) return offset;
  if (offset >= 0x16c && offset <= 0x184) return offset - 0x44; // INTR … IRQ1_INTS
  return -1; // RXF_PUTGET, GPIOBASE
}

/** An rp2040js peripheral as one of the SoC's register blocks (its atomic aliases included). */
export class RpjsBlock extends Periph {
  readonly peripheral: Peripheral;
  private readonly pio: boolean;

  constructor(name: string, base: number, host: PeriphHost, peripheral: Peripheral, pio = false) {
    super(name, base, host);
    this.peripheral = peripheral;
    this.pio = pio;
  }

  override read(offset: number): number {
    const at = this.pio ? pioOffset(offset) : offset;
    if (at < 0) return this.readStored(offset);
    return this.peripheral.readUint32(at) >>> 0;
  }

  override write(offset: number, value: number, alias: number): void {
    const at = this.pio ? pioOffset(offset) : offset;
    if (at < 0) {
      if (offset === 0x168 && applyAlias(this.regs[offset >>> 2], value, alias) !== 0) this.host.unmodelled(this.name, this.base + offset, true); // GPIOBASE 16: GPIOs 16–47
      this.store(offset, value, alias);
      return;
    }
    // Always through writeUint32Atomic, as rp2040js's bus does: it records the raw value its
    // write-1-to-clear registers (USB's BUFF_STATUS, SIE_STATUS, …) clear with.
    this.peripheral.writeUint32Atomic(at, value >>> 0, alias);
  }
}
