/**
 * The ESP32 as a bench `Mcu` (BT34): an Esp32Soc behind the frozen contract.
 *
 * - `clockHz` is the SoC's 240 MHz reference clock, not CCOUNT: the CPU clock changes at run
 *   time (40 → 160 → 240 MHz while booting, whatever setCpuFrequencyMhz asks later), and an
 *   instruction costs 240 / cpuMHz reference cycles. `cycles` is the SoC's time since the last
 *   reset — during a run, the executing core's local time, so pin listeners see the store's time.
 * - Pins: one McuPin `GPIO<n>` per GPIO the chip has (0–19, 21–23, 25–27, 32–39). Mode and level
 *   come from the pad resolver (soc/pads.ts), and on GPIO25/26 the DAC's volts (`outputVolts`,
 *   BT41); listeners fire when any of them changes. Inputs apply
 *   3.3 V CMOS thresholds with hysteresis (VIH 0.75·VDD = 2.475 V, VIL 0.25·VDD = 0.825 V — the
 *   ESP32 datasheet's DC characteristics); a floating net keeps the pad at 0, and the firmware
 *   reading such a pad is reported once per pin.
 * - `load` takes `esp32-bin` images (app + optional partition table) and boots them directly
 *   (boot/direct-boot.ts); `reset` builds a fresh SoC and boots again (`cycles` back to 0, pin
 *   objects and listeners kept). `uart(0..2)` are the three UARTs (`receive` queues bytes on the
 *   RX line at the configured baud, BT35); `i2c(0|1)` the I2C controllers and `spi(2|3)` the
 *   SPI2 (HSPI) / SPI3 (VSPI) masters (BT36; SPI0/1 run the flash). A bus's `pins()` follow the
 *   firmware's routing (GPIO matrix or IO_MUX); before the firmware routes them they are the
 *   Arduino defaults — I2C0 SDA 21 / SCL 22, VSPI SCK 18 / MOSI 23 / MISO 19, HSPI 14 / 13 / 12
 *   — so a bench built before the firmware runs attaches devices there; I2C1 has none.
 * - The ROM: `createEsp32Mcu({ rom })` checks the bytes against rom-manifest's SHA-256 and parses
 *   them once per byte array. Without a valid ROM the Mcu still exists, reports
 *   `esp32-rom-missing` with the command that fetches it, and `runUntil` returns `halted`.
 * - Outside the contract: `onProblem` hears the SoC's Problems (unknown registers, reboots, …)
 *   one by one; `esp32McuFactory` turns them into one bench Problem per code on the board part
 *   (the newest few messages and a count), through the report function the bench hands
 *   `BenchEnv.createMcu`. `soc` is there for tests and debugging.
 */

import type { BoardSpec, FirmwareImage, I2cController, I2cDevice, Level, Mcu, McuPin, NetState, PinMode, Problem, RunResult, SpiController, SpiDevice, UartPort } from '@benchtop/core';
import { describeFirmwareFormat } from '@benchtop/core';
import { directBoot } from './boot/direct-boot.ts';
import { ROM_ELF_NAME, ROM_ELF_SHA256, ROM_RELEASE } from './boot/rom-manifest.ts';
import { parseRomElf, type RomImage } from './boot/rom.ts';
import { REF_HZ } from './soc/context.ts';
import { GPIO_NUMBERS } from './soc/iomux.ts';
import { PAD_MODE } from './soc/pads.ts';
import type { SocProblem } from './soc/periph.ts';
import { Esp32Soc } from './soc/soc.ts';
import type { Spi, SpiAttachment } from './soc/spi.ts';
import { sha256Hex } from './util/sha256.ts';

export const CODE_ROM_MISSING = 'esp32-rom-missing';
export const CODE_FLOATING_INPUT = 'esp32-floating-input';
export const ROM_MISSING_MESSAGE = `ESP32 ROM not installed — run npm run fetch:esp32-rom (it downloads esp-rom-elfs ${ROM_RELEASE}, ≈ 3.4 MB, into .cache/esp32-rom after you approve it).`;
/** ESP32 input thresholds at VDD 3.3 V (datasheet: VIH ≥ 0.75·VDD, VIL ≤ 0.25·VDD). */
export const ESP32_VIH = 2.475;
export const ESP32_VIL = 0.825;

const MODES: readonly PinMode[] = ['input', 'input-pullup', 'input-pulldown', 'output', 'analog', 'peripheral'];

export interface Esp32McuOptions {
  /** `esp32_rev0_rom.elf` from esp-rom-elfs (rom-manifest). Missing or wrong: the Mcu reports it and won't run. */
  rom?: Uint8Array;
}

/** Parsed ROMs by byte array (a bench rebuild creates new Mcus with the same bytes). */
const parsedRoms = new WeakMap<Uint8Array, RomImage | string>();

function romFrom(bytes: Uint8Array | undefined): RomImage | string {
  if (bytes === undefined || bytes.length === 0) return ROM_MISSING_MESSAGE;
  const cached = parsedRoms.get(bytes);
  if (cached !== undefined) return cached;
  let result: RomImage | string;
  const hash = sha256Hex(bytes);
  if (hash !== ROM_ELF_SHA256) result = `The ESP32 ROM isn't the pinned ${ROM_ELF_NAME} from esp-rom-elfs ${ROM_RELEASE} (SHA-256 ${hash}); run npm run fetch:esp32-rom.`;
  else {
    try {
      result = parseRomElf(bytes);
    } catch (error) {
      result = `The ESP32 ROM ELF can't be read: ${(error as Error).message}`;
    }
  }
  parsedRoms.set(bytes, result);
  return result;
}

class Esp32Pin implements McuPin {
  readonly id: string;
  readonly gpio: number;
  /** Last input: level after thresholds (0/1), floating, volts (BT35's ADC reads them). */
  inputLevel = 0;
  floating = true;
  volts = 0;
  readonly listeners: (() => void)[] = [];
  private readonly mcu: Esp32Mcu;

  constructor(mcu: Esp32Mcu, gpio: number) {
    this.mcu = mcu;
    this.gpio = gpio;
    this.id = `GPIO${gpio}`;
  }

  mode(): PinMode {
    return MODES[this.mcu.soc.pads.mode[this.gpio]];
  }

  outputLevel(): Level {
    return this.mcu.soc.pads.level[this.gpio] === 1 ? 1 : 0;
  }

  /** The DAC's volts on GPIO25/26 while it drives the pad (BT41). */
  outputVolts(): number | undefined {
    const volts = this.mcu.soc.pads.dacVolts[this.gpio];
    return Number.isNaN(volts) ? undefined : volts;
  }

  setInput(state: NetState): void {
    this.volts = state.volts;
    this.floating = state.level === null;
    let level = this.inputLevel;
    if (state.level === null) level = 0;
    else if (state.volts >= ESP32_VIH) level = 1;
    else if (state.volts <= ESP32_VIL) level = 0;
    this.inputLevel = level;
    this.mcu.soc.gpio.setPadFloating(this.gpio, this.floating);
    this.mcu.soc.gpio.setPadInput(this.gpio, level);
  }

  onOutputChange(listener: () => void): void {
    this.listeners.push(listener);
  }
}

/** Bus signals (gpio_sig_map.h) and the Arduino default pins used before the firmware routes them. */
const I2C_SIGNALS = [
  { sda: 30, scl: 29, defaults: { sda: 'GPIO21', scl: 'GPIO22' } },
  { sda: 96, scl: 95, defaults: { sda: '', scl: '' } },
] as const;
const SPI_SIGNALS = {
  2: { sck: 8, mosi: 10, miso: 9, defaults: { sck: 'GPIO14', mosi: 'GPIO13', miso: 'GPIO12' } },
  3: { sck: 63, mosi: 65, miso: 64, defaults: { sck: 'GPIO18', mosi: 'GPIO23', miso: 'GPIO19' } },
} as const;

class Esp32I2c implements I2cController {
  devices: I2cDevice[] = [];
  private readonly mcu: Esp32Mcu;
  private readonly index: 0 | 1;

  constructor(mcu: Esp32Mcu, index: 0 | 1) {
    this.mcu = mcu;
    this.index = index;
  }

  pins(): { sda: string; scl: string } {
    const s = I2C_SIGNALS[this.index];
    const pads = this.mcu.soc.pads;
    const sda = pads.pinOfOutSignal(s.sda);
    const scl = pads.pinOfOutSignal(s.scl);
    if (sda < 0 || scl < 0) return { ...s.defaults };
    return { sda: `GPIO${sda}`, scl: `GPIO${scl}` };
  }

  attach(device: I2cDevice): void {
    if (!this.devices.includes(device)) this.devices = [...this.devices, device];
    this.mcu.soc.i2c[this.index].devices = this.devices;
  }

  detach(device: I2cDevice): void {
    this.devices = this.devices.filter((d) => d !== device);
    this.mcu.soc.i2c[this.index].devices = this.devices;
  }
}

class Esp32Spi implements SpiController {
  devices: SpiAttachment[] = [];
  private readonly mcu: Esp32Mcu;
  readonly host: 2 | 3;

  constructor(mcu: Esp32Mcu, host: 2 | 3) {
    this.mcu = mcu;
    this.host = host;
  }

  pins(): { sck: string; mosi: string; miso: string } {
    const s = SPI_SIGNALS[this.host];
    const pads = this.mcu.soc.pads;
    const sck = pads.pinOfOutSignal(s.sck);
    const mosi = pads.pinOfOutSignal(s.mosi);
    const miso = pads.pinOfInSignal(s.miso);
    if (sck < 0 || mosi < 0 || miso < 0) return { ...s.defaults };
    return { sck: `GPIO${sck}`, mosi: `GPIO${mosi}`, miso: `GPIO${miso}` };
  }

  attach(device: SpiDevice, selected: () => boolean): void {
    if (!this.devices.some((a) => a.device === device)) this.devices = [...this.devices, { device, selected }];
    this.socSpi().devices = this.devices;
  }

  detach(device: SpiDevice): void {
    this.devices = this.devices.filter((a) => a.device !== device);
    this.socSpi().devices = this.devices;
  }

  socSpi(): Spi {
    return this.host === 2 ? this.mcu.soc.spi2 : this.mcu.soc.spi3;
  }
}

/** UnTXD_OUT_IDX = UnRXD_IN_IDX per UART (gpio_sig_map.h: U0 14, U1 17, U2 198). */
const UART_SIGNALS = [14, 17, 198] as const;

class Esp32Uart implements UartPort {
  readonly listeners: ((byte: number) => void)[] = [];
  private readonly mcu: Esp32Mcu;
  private readonly index: number;

  constructor(mcu: Esp32Mcu, index: number) {
    this.mcu = mcu;
    this.index = index;
  }

  onTransmit(listener: (byte: number) => void): void {
    this.listeners.push(listener);
  }

  /** Bytes for the firmware: they arrive at the UART's baud rate from now (BT35). */
  receive(bytes: Uint8Array): void {
    this.mcu.soc.uarts[this.index].receive(bytes);
  }

  /** BT39: the pads carrying UARTn's TXD output and RXD input now (IO_MUX direct or the GPIO matrix). */
  pins(): { tx?: string; rx?: string } {
    const signal = UART_SIGNALS[this.index];
    const pads = this.mcu.soc.pads;
    const tx = pads.pinOfOutSignal(signal);
    const rx = pads.pinOfInSignal(signal);
    const pins: { tx?: string; rx?: string } = {};
    if (tx >= 0) pins.tx = `GPIO${tx}`;
    if (rx >= 0) pins.rx = `GPIO${rx}`;
    return pins;
  }

  /** BT39: the configured rate (CLKDIV on APB or REF_TICK). */
  baud(): number {
    return this.mcu.soc.uarts[this.index].baud();
  }

  emit(byte: number): void {
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i](byte);
  }
}

export class Esp32Mcu implements Mcu {
  readonly kind = 'esp32' as const;
  readonly clockHz = REF_HZ;
  readonly pins: ReadonlyMap<string, McuPin>;
  /** The SoC of the current boot (a reset replaces it). */
  soc: Esp32Soc;
  private problemListener: ((problem: SocProblem) => void) | null = null;
  private readonly rom: RomImage | string;
  private image: { app: Uint8Array; partitions?: Uint8Array } | null = null;
  private bootError = '';
  private readonly byGpio: (Esp32Pin | undefined)[] = new Array<Esp32Pin | undefined>(40).fill(undefined);
  private readonly uarts = [new Esp32Uart(this, 0), new Esp32Uart(this, 1), new Esp32Uart(this, 2)];
  private readonly i2cs = [new Esp32I2c(this, 0), new Esp32I2c(this, 1)];
  private readonly spis = [new Esp32Spi(this, 2), new Esp32Spi(this, 3)];
  /** Mode/level each pin's listeners last saw. */
  private readonly seenMode = new Uint8Array(40);
  private readonly seenLevel = new Uint8Array(40);
  private readonly seenVolts = new Float64Array(40).fill(Number.NaN);
  private readonly floatingReported = new Uint8Array(40);

  constructor(options: Esp32McuOptions = {}) {
    this.rom = romFrom(options.rom);
    const pins = new Map<string, McuPin>();
    for (const g of GPIO_NUMBERS) {
      const pin = new Esp32Pin(this, g);
      this.byGpio[g] = pin;
      pins.set(pin.id, pin);
    }
    this.pins = pins;
    this.soc = this.buildSoc();
    for (const g of GPIO_NUMBERS) {
      this.seenMode[g] = this.soc.pads.mode[g];
      this.seenLevel[g] = this.soc.pads.level[g];
    }
  }

  /**
   * The SoC's Problems and the adapter's own (`esp32-rom-missing`, floating reads). Setting it
   * reports a missing or bad ROM at once.
   */
  get onProblem(): ((problem: SocProblem) => void) | null {
    return this.problemListener;
  }

  set onProblem(listener: ((problem: SocProblem) => void) | null) {
    this.problemListener = listener;
    if (typeof this.rom === 'string') this.report('error', CODE_ROM_MISSING, 0, this.rom);
  }

  /** Reference cycles since the last reset (the executing core's time during a run). */
  get cycles(): number {
    return this.soc.now();
  }

  /** The ROM problem, or '' when the ROM is installed and valid. */
  get romProblem(): string {
    return typeof this.rom === 'string' ? this.rom : '';
  }

  load(image: FirmwareImage): void {
    if (image.format !== 'esp32-bin') throw new Error(`The ESP32 runs app images (.bin); got ${describeFirmwareFormat(image.format)}.`);
    const previous = this.image;
    this.image = image.partitions === undefined ? { app: image.app } : { app: image.app, partitions: image.partitions };
    this.reset();
    if (this.bootError !== '') {
      const error = this.bootError;
      this.image = previous;
      this.reset();
      throw new Error(error);
    }
  }

  reset(): void {
    this.soc = this.buildSoc();
    this.bootError = '';
    if (typeof this.rom === 'string') {
      this.report('error', CODE_ROM_MISSING, 0, this.rom);
    } else if (this.image !== null) {
      const boot = directBoot(this.soc, { app: this.image.app, ...(this.image.partitions === undefined ? {} : { partitions: this.image.partitions }), rom: this.rom });
      if (!boot.ok) this.bootError = `The ESP32 image can't boot: ${boot.error}`;
    }
    this.floatingReported.fill(0);
    // The new SoC's pads read the nets as the pins last saw them; listeners hear what changed.
    for (const g of GPIO_NUMBERS) {
      const pin = this.byGpio[g];
      if (pin === undefined) continue;
      this.soc.gpio.setPadFloating(g, pin.floating);
      this.soc.gpio.setPadInput(g, pin.inputLevel);
    }
    for (const g of GPIO_NUMBERS) this.pinChanged(g);
  }

  runUntil(targetCycles: number): RunResult {
    if (typeof this.rom === 'string') return { reason: 'halted', detail: this.rom };
    if (this.image === null) return { reason: 'halted', detail: 'No firmware loaded.' };
    if (this.bootError !== '') return { reason: 'halted', detail: this.bootError };
    return this.soc.runUntil(targetCycles);
  }

  uart(index: number): UartPort | undefined {
    return this.uarts[index];
  }

  i2c(index: number): I2cController | undefined {
    return index === 0 || index === 1 ? this.i2cs[index] : undefined;
  }

  /** SPI2 (HSPI) is `spi(2)`, SPI3 (VSPI) `spi(3)`; SPI0/1 run the flash. */
  spi(index: number): SpiController | undefined {
    return index === 2 ? this.spis[0] : index === 3 ? this.spis[1] : undefined;
  }

  private buildSoc(): Esp32Soc {
    const soc = new Esp32Soc();
    soc.onUart = (port, byte) => this.uarts[port]?.emit(byte);
    soc.problems.listener = (problem) => this.problemListener?.(problem);
    soc.pads.onPin = (g) => this.pinChanged(g);
    soc.gpio.onFloatingRead = (g) => this.floatingRead(g);
    soc.rtc.sens.padVolts = (g) => (this.byGpio[g] as Esp32Pin | undefined)?.volts ?? 0;
    // The bus devices outlive the SoC (a reset builds a new one); during construction the lists are empty.
    if (this.i2cs !== undefined) {
      soc.i2c[0].devices = this.i2cs[0].devices;
      soc.i2c[1].devices = this.i2cs[1].devices;
      soc.spi2.devices = this.spis[0].devices;
      soc.spi3.devices = this.spis[1].devices;
    }
    return soc;
  }

  private pinChanged(g: number): void {
    const pin = this.byGpio[g];
    if (pin === undefined) return;
    const mode = this.soc.pads.mode[g];
    const level = this.soc.pads.level[g];
    const volts = this.soc.pads.dacVolts[g];
    const seen = this.seenVolts[g];
    if (mode === this.seenMode[g] && level === this.seenLevel[g] && (volts === seen || (Number.isNaN(volts) && Number.isNaN(seen)))) return;
    this.seenMode[g] = mode;
    this.seenLevel[g] = level;
    this.seenVolts[g] = volts;
    for (let i = 0; i < pin.listeners.length; i++) pin.listeners[i]();
  }

  /** The firmware read GPIO_IN while pad `g` was floating with its input enabled. */
  private floatingRead(g: number): void {
    const pin = this.byGpio[g];
    if (pin === undefined || !pin.floating || this.floatingReported[g] !== 0) return;
    if (this.soc.pads.mode[g] !== PAD_MODE.INPUT) return;
    this.floatingReported[g] = 1;
    this.report('warning', CODE_FLOATING_INPUT, g, `GPIO${g} is read while floating (nothing drives it and it has no pull): it reads 0. Add a pull-up/pull-down or drive it.`);
  }

  private report(severity: SocProblem['severity'], code: string, address: number, message: string): void {
    this.problemListener?.({ severity, code, message, address });
  }
}

/**
 * The bench's MCU factory for ESP32 boards (`BenchEnv.createMcu`), as avrMcuFactory is for the
 * Uno: `rom` is the ROM ELF the environment loaded (or undefined: the board then reports
 * `esp32-rom-missing`). Problems go to `report`, one per code, newest messages first-come.
 */
export function esp32McuFactory(rom: Uint8Array | undefined): (board: BoardSpec, partId: string, report?: (problem: Problem) => void) => Mcu | undefined {
  return (board, partId, report) => {
    if (board.mcu !== 'esp32') return undefined;
    const mcu = createEsp32Mcu(rom === undefined ? {} : { rom });
    if (report !== undefined) {
      const seen = new Map<string, { messages: string[]; count: number }>();
      let soc = mcu.soc;
      mcu.onProblem = (problem) => {
        if (mcu.soc !== soc) {
          soc = mcu.soc; // a reset: the bench cleared its Problems too
          seen.clear();
        }
        let entry = seen.get(problem.code);
        if (entry === undefined) seen.set(problem.code, (entry = { messages: [], count: 0 }));
        entry.count++;
        if (entry.messages.length < 3 && !entry.messages.includes(problem.message)) entry.messages.push(problem.message);
        const more = entry.count - entry.messages.length;
        report({ severity: problem.severity, code: problem.code, message: entry.messages.join(' · ') + (more > 0 ? ` (+${more} more)` : ''), parts: [partId] });
      };
    }
    return mcu;
  };
}

/** A fresh ESP32 for a board part. */
export function createEsp32Mcu(options: Esp32McuOptions = {}): Esp32Mcu {
  return new Esp32Mcu(options);
}
