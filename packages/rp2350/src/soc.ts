/**
 * The RP2350 SoC, RISC-V side (BT65): two Hazard3 harts (@benchtop/riscv) on the chip's memory map
 * (RP2350 datasheet §2.2), with Benchtop's own peripheral models and the real bootrom (release
 * A4, `npm run fetch:rp2350-rom`) at 0x00000000, which boots the flash image (much of it Arm code
 * the RISC-V bootrom runs through its varmulet emulator), parks core 1 until a launch, and serves
 * the ROM API the SDK calls (flash programming included).
 *
 *   0x00000000  ROM, 32 KB (writes are ignored, as on the chip — the bootrom relies on it)
 *   0x10000000  XIP flash (4 MB on the Pico 2, mirrored through the 16 MB window), also through the
 *               uncached aliases at 0x14000000 and 0x1c000000; 0x11000000 (CS1, PSRAM) has no
 *               device: reads 0, writes are dropped; 0x13ffc000 the 16 KB XIP cache as SRAM;
 *               0x18000000 cache maintenance (writes dropped)
 *   0x20000000  SRAM, 520 KB (SRAM0–9; the striping is invisible to software)
 *   0x400e0000  BOOTRAM's 1 KB and 0x50100000 USB's 4 KB DPRAM: plain RAM
 *   0x40000000  APB peripherals, 0x50000000 AHB peripherals: a block per 16 KB, its 4 KB of
 *               registers and their XOR/SET/CLR aliases (+0x1000/0x2000/0x3000); 8- and 16-bit
 *               writes are replicated across the word, as the bus does
 *   0xd0000000  SIO (per hart)
 *   anything else: a bus error (the hart takes an access fault)
 *
 * Time: simulated nanoseconds (clock.ts). A hart's instruction takes one clk_sys cycle (the core's
 * count), and clk_sys follows the clock tree (ROSC at boot, 150 MHz once the SDK sets the PLL up).
 * The run loop runs the harts in slices up to the next alarm and lets alarms fire between them;
 * an alarm scheduled earlier than the slice's end stops the hart at its next instruction.
 */

import { type RiscvBus, RiscvBusError, type RiscvCodeBus, RiscvCore, HALT, IRQ } from '@benchtop/riscv';
import { RPI2C, RPPIO, RPUSBController, type StateMachine } from 'rp2040js';
import { BootError, findImageDef, type ImageDef } from './boot.ts';
import { type Alarm, SocClock } from './clock.ts';
import { Periph, type PeriphHost } from './periph/block.ts';
import { Adc } from './periph/adc.ts';
import { FlashChip } from './periph/flash-chip.ts';
import { FUNC_PIO0, FUNC_PWM, FUNC_SPI, GPIO_COUNT, IoBank0, IoQspi, PAD_IE, PAD_ISO, PadsBank0, type PinDrive } from './periph/gpio.ts';
import { Pwm } from './periph/pwm.ts';
import { Qmi } from './periph/qmi.ts';
import { RpjsBlock, rpjsHost } from './periph/rpjs.ts';
import { Pl022 } from './periph/spi.ts';
import { Sio, type SioHost } from './periph/sio.ts';
import { Bootram, Clocks, Otp, Pll, Psm, Quiet, Resets, Rosc, Sysinfo, Watchdog, Xosc } from './periph/system.ts';
import { Timer } from './periph/timer.ts';
import { Uart } from './periph/uart.ts';
import { IRQ_COUNT, Xh3Irq } from './xh3irq.ts';

export const ROM_SIZE = 0x8000;
export const FLASH_SIZE = 4 * 1024 * 1024;
export const SRAM_BASE = 0x20000000;
export const SRAM_SIZE = 0x82000;
export const SRAM_TOP = SRAM_BASE + SRAM_SIZE;
const XIP_SRAM_BASE = 0x13ffc000;
const XIP_SRAM_SIZE = 0x4000;
const BOOTRAM_BASE = 0x400e0000;
const BOOTRAM_SIZE = 0x400;
/** USB's dual-port RAM: plain RAM to software (the bootrom keeps varmulet's state there). */
const DPRAM_BASE = 0x50100000;
const DPRAM_SIZE = 0x1000;
const OTP_DATA_BASE = 0x40130000;
/** The reset entry both harts would take in the bootrom (BOOTROM_ENTRY_OFFSET). */
export const ROM_ENTRY = 0x7dfc;
/** clk_sys after the SDK's clock setup; the time base of `Rp2350Soc.cycles`. */
export const REFERENCE_HZ = 150_000_000;
/** Longest uninterrupted run of a hart, ns. */
const SLICE_NANOS = 20_000;
/** …while a PIO state machine runs (CPU and PIO interleave within this). */
const PIO_SLICE_NANOS = 2_000;
const MAX_HZ = 1_000_000_000;

export interface SocProblem {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface Rp2350SocOptions {
  /** The 32 KB bootrom image (bootrom-combined.bin). */
  rom: Uint8Array;
  onProblem?: (problem: SocProblem) => void;
}

class HartBus implements RiscvBus, RiscvCodeBus {
  private readonly soc: Rp2350Soc;
  private readonly hart: number;
  constructor(soc: Rp2350Soc, hart: number) {
    this.soc = soc;
    this.hart = hart;
  }
  read8(addr: number): number {
    return this.soc.read(this.hart, addr >>> 0, 1);
  }
  read16(addr: number): number {
    return this.soc.read(this.hart, addr >>> 0, 2);
  }
  read32(addr: number): number {
    return this.soc.read(this.hart, addr >>> 0, 4);
  }
  write8(addr: number, value: number): void {
    this.soc.write(this.hart, addr >>> 0, value & 0xff, 1);
  }
  write16(addr: number, value: number): void {
    this.soc.write(this.hart, addr >>> 0, value & 0xffff, 2);
  }
  write32(addr: number, value: number): void {
    this.soc.write(this.hart, addr >>> 0, value >>> 0, 4);
  }
  fetch16(addr: number): number {
    return this.soc.fetch16(addr >>> 0);
  }
  codePage(address: number): boolean {
    return this.soc.codePage(address >>> 0);
  }
  codeHalf(address: number): number {
    return this.soc.fetch16(address >>> 0);
  }
}

export class Rp2350Soc implements PeriphHost, SioHost {
  readonly rom = new Uint8Array(ROM_SIZE);
  readonly flash = new Uint8Array(FLASH_SIZE).fill(0xff);
  readonly sram = new Uint8Array(SRAM_SIZE);
  readonly xipSram = new Uint8Array(XIP_SRAM_SIZE);
  readonly bootram = new Uint8Array(BOOTRAM_SIZE);
  readonly dpram = new Uint8Array(DPRAM_SIZE);
  readonly clock = new SocClock();
  readonly harts: [RiscvCore, RiscvCore];
  readonly irqs: [Xh3Irq, Xh3Irq];
  /** Each hart's view of the 52 interrupt lines (most are shared; IO_BANK0's is per core). */
  readonly lines = [new Uint32Array(2), new Uint32Array(2)];
  /** Hart 1 runs once the SDK launched it. */
  readonly running = [true, false];
  readonly sio: Sio;
  readonly clocks: Clocks;
  readonly psm: Psm;
  readonly io: IoBank0;
  readonly pads: PadsBank0;
  readonly uarts: [Uart, Uart];
  readonly timers: [Timer, Timer];
  readonly flashChip: FlashChip;
  readonly pwm: Pwm;
  readonly adc: Adc;
  readonly spi: [Pl022, Pl022];
  /** rp2040js's I2C, PIO and USB classes on this chip (rpjs.ts), new at every reset. */
  i2c: RPI2C[] = [];
  pio: RPPIO[] = [];
  usb: RPUSBController | null = null;
  /** rp2040js's clock interface over this SoC's (USB serial's alarms). */
  readonly rpjsClock: { readonly nanos: number; createAlarm(callback: () => void): { schedule(deltaNanos: number): void; cancel(): void } };
  private pioMachines: StateMachine[] = [];
  /** Per PIO state machine: when it steps next, ns. */
  private readonly pioNext = new Float64Array(12);
  /** Alarms the rp2040js peripherals hold (released at reset). */
  private rpjsAlarms: Alarm[] = [];
  onProblem: ((problem: SocProblem) => void) | null;
  /** GPIO drive or pads changed (the Mcu adapter re-reads pins). */
  onPinsChanged: (() => void) | null = null;
  /** Inputs the bench drives (bits per GPIO). */
  readonly inputs = new Uint32Array(2);

  private readonly rom16: Uint16Array;
  private readonly rom32: Uint32Array;
  private readonly flash16: Uint16Array;
  private readonly flash32: Uint32Array;
  private readonly sram16: Uint16Array;
  private readonly sram32: Uint32Array;
  private readonly xip16: Uint16Array;
  private readonly xip32: Uint32Array;
  private readonly boot16: Uint16Array;
  private readonly boot32: Uint32Array;
  private readonly dpram16: Uint16Array;
  private readonly dpram32: Uint32Array;
  /** Peripheral blocks by base >>> 14. */
  private readonly blocks = new Map<number, Periph>();
  /** SRAM pages a hart predecoded (a write there drops them). */
  private readonly codePages = new Uint8Array(SRAM_SIZE >>> 12);
  private readonly reported = new Set<number>();
  /** Per hart: time and cycle count at the last rebase (clk_sys change). */
  private readonly baseNanos = new Float64Array(2);
  private readonly baseCycles = new Float64Array(2);
  private nanosPerCycle = 1e9 / 11_000_000;
  /** The hart executing now (whose time peripherals see), −1 between slices. */
  private active = -1;
  /** End of the slice running now, ns (an earlier alarm stops the hart). */
  private sliceEnd = Infinity;

  constructor(options: Rp2350SocOptions) {
    if (options.rom.length !== ROM_SIZE) throw new Error(`the RP2350 bootrom is ${ROM_SIZE} bytes; got ${options.rom.length}`);
    this.rom.set(options.rom);
    this.onProblem = options.onProblem ?? null;
    this.rom16 = new Uint16Array(this.rom.buffer);
    this.rom32 = new Uint32Array(this.rom.buffer);
    this.flash16 = new Uint16Array(this.flash.buffer);
    this.flash32 = new Uint32Array(this.flash.buffer);
    this.sram16 = new Uint16Array(this.sram.buffer);
    this.sram32 = new Uint32Array(this.sram.buffer);
    this.xip16 = new Uint16Array(this.xipSram.buffer);
    this.xip32 = new Uint32Array(this.xipSram.buffer);
    this.boot16 = new Uint16Array(this.bootram.buffer);
    this.boot32 = new Uint32Array(this.bootram.buffer);
    this.dpram16 = new Uint16Array(this.dpram.buffer);
    this.dpram32 = new Uint32Array(this.dpram.buffer);

    const opts = (hart: number) => ({ resetPc: ROM_ENTRY, mhartid: hart, mvendorid: 0x493, marchid: 0x1b, mimpid: 0x86fc4e3f, pmpEntries: 8 });
    this.harts = [new RiscvCore(new HartBus(this, 0), opts(0)), new RiscvCore(new HartBus(this, 1), opts(1))];
    this.irqs = [new Xh3Irq(this.harts[0], this.lines[0]), new Xh3Irq(this.harts[1], this.lines[1])];
    // h3.unblock reaches both harts — on the RP2350 the sender's own next h3.block falls through too.
    for (const hart of this.harts) hart.unblockHook = () => this.unblockAll();
    this.clock.onEarlier = (at) => {
      if (this.active >= 0 && at < this.sliceEnd) {
        this.harts[this.active].requestStop();
        this.cut = true;
      }
    };

    const add = <T extends Periph>(periph: T): T => {
      this.blocks.set(periph.base >>> 14, periph);
      return periph;
    };
    const quiet = (name: string, base: number): Quiet => add(new Quiet(name, base, this));
    const xosc = add(new Xosc('XOSC', 0x40048000, this));
    const pllSys = add(new Pll('PLL_SYS', 0x40050000, this));
    const pllUsb = add(new Pll('PLL_USB', 0x40058000, this));
    this.clocks = add(new Clocks('CLOCKS', 0x40010000, this, xosc, pllSys, pllUsb));
    this.clocks.onSysChange = () => this.rebase();
    add(new Sysinfo('SYSINFO', 0x40000000, this));
    quiet('SYSCFG', 0x40008000);
    this.psm = add(new Psm('PSM', 0x40018000, this));
    this.psm.onCore1Reset = (held) => this.core1Reset(held);
    add(new Resets('RESETS', 0x40020000, this));
    this.io = add(new IoBank0('IO_BANK0', 0x40028000, this, (hart, level) => this.setCoreIrq(hart, 21, level)));
    this.io.onChange = () => this.onPinsChanged?.();
    add(new IoQspi('IO_QSPI', 0x40030000, this, () => this.flashChip.isSelected));
    this.pads = add(new PadsBank0('PADS_BANK0', 0x40038000, this));
    this.pads.onChange = () => this.onPinsChanged?.();
    quiet('PADS_QSPI', 0x40040000);
    quiet('ACCESSCTRL', 0x40060000);
    quiet('BUSCTRL', 0x40068000);
    const peri = (): number => this.clocks.periHz;
    this.uarts = [add(new Uart('UART0', 0x40070000, this, this.clock, 33, peri)), add(new Uart('UART1', 0x40078000, this, this.clock, 34, peri))];
    this.timers = [add(new Timer('TIMER0', 0x400b0000, this, this.clock, 0)), add(new Timer('TIMER1', 0x400b8000, this, this.clock, 4))];
    quiet('XIP_CTRL', 0x400c8000);
    this.flashChip = new FlashChip(this.flash);
    this.flashChip.onChange = (start, end) => {
      for (const alias of [0x10000000, 0x14000000, 0x1c000000]) this.invalidate(alias + start, end - start);
    };
    add(new Qmi('QMI', 0x400d0000, this, this.flashChip));
    add(new Watchdog('WATCHDOG', 0x400d8000, this));
    add(new Bootram('BOOTRAM', BOOTRAM_BASE, this));
    add(new Rosc('ROSC', 0x400e8000, this));
    quiet('TRNG', 0x400f0000);
    quiet('SHA256', 0x400f8000);
    quiet('POWMAN', 0x40100000);
    quiet('TICKS', 0x40108000);
    add(new Otp('OTP', 0x40120000, this));
    quiet('GLITCH_DETECTOR', 0x40158000);
    quiet('TBMAN', 0x40160000);
    // BT66: PWM, the ADC and SPI are this package's; I2C, PIO and USB rp2040js's (rpjs.ts, at reset).
    this.pwm = add(new Pwm('PWM', 0x400a8000, this, this.clock, () => this.clocks.sysHz));
    this.pwm.onChange = () => this.onPinsChanged?.();
    this.adc = add(new Adc('ADC', 0x400a0000, this, this.clock));
    this.spi = [add(new Pl022('SPI0', 0x40080000, this, 31)), add(new Pl022('SPI1', 0x40088000, this, 32))];
    this.io.peripheralDrive = (n, f, out) => this.peripheralDrive(n, f, out);
    const soc = this;
    this.rpjsClock = {
      get nanos(): number {
        return soc.now();
      },
      createAlarm(callback: () => void) {
        const alarm = soc.rpjsAlarm(callback);
        return { schedule: (delta: number) => alarm.scheduleAt(soc.now() + Math.max(0, delta)), cancel: () => alarm.cancel() };
      },
    };
    // Not modelled yet: their registers keep what is written, and each one touched is reported.
    const generic = (name: string, base: number): Periph => add(new Periph(name, base, this));
    generic('HSTX_CTRL', 0x400c0000);
    generic('DMA', 0x50000000);
    generic('XIP_AUX', 0x50500000);
    generic('HSTX_FIFO', 0x50600000);
    this.sio = new Sio(this, this.clock);
    this.reset();
  }

  // ── PeriphHost / SioHost ────────────────────────────────────────────────────────────────

  /** A hart's time now, ns. */
  private hartNanos(hart: number): number {
    return this.baseNanos[hart] + (this.harts[hart].cycles - this.baseCycles[hart]) * this.nanosPerCycle;
  }

  /** Simulated time: the running hart's own, else (between slices, while PIO steps) the clock's. */
  now(): number {
    return this.active < 0 ? this.clock.nanos : Math.max(this.clock.nanos, this.hartNanos(this.active));
  }

  sysHz(): number {
    return this.clocks.sysHz;
  }

  setIrq(irq: number, level: boolean): void {
    this.setCoreIrq(0, irq, level);
    this.setCoreIrq(1, irq, level);
  }

  private setCoreIrq(hart: number, irq: number, level: boolean): void {
    if (irq >= IRQ_COUNT) return;
    const w = irq >>> 5;
    const bit = 1 << (irq & 31);
    const lines = this.lines[hart];
    const before = lines[w];
    lines[w] = level ? before | bit : before & ~bit;
    if (lines[w] !== before) this.irqs[hart].update();
  }

  private unblockAll(): void {
    this.harts[0].unblock();
    this.harts[1].unblock();
  }

  setSoftIrq(hart: number, level: boolean): void {
    this.harts[hart].setInterruptLine(IRQ.MSI, level);
  }

  setTimerIrq(hart: number, level: boolean): void {
    this.harts[hart].setInterruptLine(IRQ.MTI, level);
  }

  gpioChanged(): void {
    this.onPinsChanged?.();
  }

  /** What SIO's GPIO_IN sees: a pad's input while its input is enabled and it isn't isolated. */
  gpioIn(high: boolean): number {
    let enabled = 0;
    const first = high ? 32 : 0;
    for (let i = 0; i < (high ? GPIO_COUNT - 32 : 32); i++) if ((this.pads.pad(first + i) & (PAD_IE | PAD_ISO)) === PAD_IE) enabled |= 1 << i;
    // GPIO_HI_IN: QSPI SD0–3 and CSn pulled up (BOOTSEL not pressed), SCK low, USB D+/D− low.
    return high ? (0xf8000000 | (this.inputs[1] & enabled & 0xffff)) >>> 0 : (this.inputs[0] & enabled) >>> 0;
  }

  /** PSM holds core 1 in reset, or lets it go: it starts over in the bootrom's wait for a launch. */
  private core1Reset(held: boolean): void {
    const hart = this.harts[1];
    this.running[1] = !held;
    if (held) return;
    hart.reset();
    this.irqs[1].reset();
    this.sio.resetCore1();
    this.baseNanos[1] = this.now();
    this.baseCycles[1] = hart.cycles;
  }

  unmodelled(block: string, address: number, write: boolean): void {
    if (this.reported.has(address)) return;
    this.reported.add(address);
    this.problem('info', 'rp2350-unimplemented', `${block}: ${write ? 'write to' : 'read of'} an unmodelled register at 0x${address.toString(16)}`);
  }

  problem(severity: SocProblem['severity'], code: string, message: string): void {
    this.onProblem?.({ severity, code, message });
  }

  // ── rp2040js's peripherals ───────────────────────────────────────────────────────────────

  /** An alarm for an rp2040js peripheral (released when they're recreated). */
  private rpjsAlarm(callback: () => void): Alarm {
    const alarm = this.clock.alarm(callback);
    this.rpjsAlarms.push(alarm);
    return alarm;
  }

  /** New I2C, PIO and USB instances (rp2040js has no reset): their blocks replace the old ones. */
  private createRpjs(): void {
    this.clock.remove(this.rpjsAlarms);
    this.rpjsAlarms = [];
    const host = rpjsHost({
      now: () => this.now(),
      alarm: (callback) => this.rpjsAlarm(callback),
      setIrq: (irq, level) => this.setIrq(irq, level),
      sysHz: () => this.clocks.sysHz,
      periHz: () => this.clocks.periHz,
      dpram: this.dpram,
      input: (n) => (this.inputs[n >>> 5] >>> (n & 31)) & 1,
      pinsChanged: () => this.onPinsChanged?.(),
      warn: (component, message) => this.problem('info', 'rp2350-unimplemented', `${component}: ${message}`),
    });
    this.i2c = [new RPI2C(host, 'I2C0', 36), new RPI2C(host, 'I2C1', 37)];
    this.pio = [new RPPIO(host, 'PIO0', 15, 0), new RPPIO(host, 'PIO1', 17, 1), new RPPIO(host, 'PIO2', 19, 2)];
    for (const pio of this.pio) pio.run = () => {}; // stepped in simulated time by the run loop
    this.pioMachines = this.pio.flatMap((pio) => pio.machines);
    this.pioNext.fill(0);
    this.usb = new RPUSBController(host, 'USB');
    const add = (periph: Periph): void => void this.blocks.set(periph.base >>> 14, periph);
    add(new RpjsBlock('I2C0', 0x40090000, this, this.i2c[0]));
    add(new RpjsBlock('I2C1', 0x40098000, this, this.i2c[1]));
    add(new RpjsBlock('PIO0', 0x50200000, this, this.pio[0], true));
    add(new RpjsBlock('PIO1', 0x50300000, this, this.pio[1], true));
    add(new RpjsBlock('PIO2', 0x50400000, this, this.pio[2], true));
    add(new RpjsBlock('USBCTRL_REGS', 0x50110000, this, this.usb));
  }

  /** PWM, PIO and SPI outputs on GPIO `n` (IO_BANK0's provider): the level in `out`, the output enable returned. */
  private peripheralDrive(n: number, f: number, out: PinDrive): number {
    if (f === FUNC_PWM) {
      out.level = this.pwm.output((n >>> 1) & 7, n & 1);
      return 1;
    }
    if (f >= FUNC_PIO0 && f <= FUNC_PIO0 + 2) {
      const pio = this.pio[f - FUNC_PIO0];
      if (pio === undefined) return 0;
      out.level = (pio.pinValues >>> n) & 1;
      return (pio.pinDirections >>> n) & 1;
    }
    if (f === FUNC_SPI) {
      // RX, CSn, SCK, TX: CSn idles high, SCK and TX low (frames travel at byte level)
      const role = n & 3;
      out.level = role === 1 ? 1 : 0;
      return role === 0 ? 0 : 1;
    }
    return 0;
  }

  /**
   * Steps the enabled PIO state machines up to `until` (ns), in time order with the clock moved
   * to each step: each executes its next instruction once its wait — its cycles, delay included,
   * × its clock divider, at clk_sys — has passed. One that stalls (on a FIFO, a pin or an IRQ)
   * looks again at the next pump: the harts ran this slice already, so whatever unblocks it is
   * there by then.
   */
  private pumpPio(from: number, until: number): void {
    const machines = this.pioMachines;
    const next = this.pioNext;
    for (;;) {
      let best = -1;
      for (let i = 0; i < machines.length; i++) {
        if (!machines[i].enabled) continue;
        if (next[i] < from) next[i] = from; // just enabled, or stalled since the last pump
        if (next[i] <= until && (best < 0 || next[i] < next[best])) best = i;
      }
      if (best < 0) return;
      const at = next[best];
      this.clock.tickTo(at);
      const machine = machines[best];
      const divider = machine.clockDivInt === 0 ? 65536 : machine.clockDivInt + machine.clockDivFrac / 256;
      const stepNanos = divider * this.nanosPerCycle;
      const loop = this.countingLoop(best);
      if (loop !== 0) {
        // JMP X-- / Y-- to itself: counts down one a cycle, nothing else changes — skip ahead.
        const count = Math.min(loop === 1 ? machine.x >>> 0 : machine.y >>> 0, Math.floor((until - at) / stepNanos) + 1);
        if (count > 1) {
          if (loop === 1) machine.x = (machine.x - count) >>> 0;
          else machine.y = (machine.y - count) >>> 0;
          machine.cycles += count;
          next[best] = at + count * stepNanos;
          continue;
        }
      }
      const before = machine.cycles;
      machine.step();
      next[best] = machine.waiting ? until + 1 : at + Math.max(1, machine.cycles - before) * stepNanos;
      this.pio[best >>> 2].checkChangedPins();
    }
  }

  /**
   * Whether state machine `i` sits on a JMP X-- (1) or Y-- (2) to its own address with no delay or
   * side-set and nothing EXEC'd pending — a counting loop (arduino-pico's cycle counter, ccount,
   * runs one at full speed on the RP2350) — else 0.
   */
  private countingLoop(i: number): number {
    const machine = this.pioMachines[i];
    if (machine.execValid || machine.waiting) return 0;
    const instr = this.pio[i >>> 2].instructions[machine.pc];
    if ((instr & 0xff00) !== 0 || (instr & 0x1f) !== machine.pc) return 0;
    const cond = (instr >>> 5) & 7;
    return cond === 2 ? 1 : cond === 4 ? 2 : 0;
  }

  /** Whether a state machine is running, not stalled and not just counting (the run loop then slices finely). */
  private pioBusy(): boolean {
    for (let i = 0; i < this.pioMachines.length; i++) {
      const machine = this.pioMachines[i];
      if (machine.enabled && !machine.waiting && this.countingLoop(i) === 0) return true;
    }
    return false;
  }

  /** Whether any state machine is enabled. */
  private pioOn(): boolean {
    for (const machine of this.pioMachines) if (machine.enabled) return true;
    return false;
  }

  // ── Reset and boot ──────────────────────────────────────────────────────────────────────

  /** Power-on reset: peripherals, harts, SRAM; flash keeps its contents. Then direct boot. */
  reset(): void {
    this.clock.clear();
    this.resumePc = -1;
    this.atBreakpoint = false;
    this.createRpjs();
    for (const periph of this.blocks.values()) periph.reset();
    this.sio.reset();
    this.sram.fill(0);
    this.xipSram.fill(0);
    this.bootram.fill(0);
    this.dpram.fill(0);
    this.lines[0].fill(0);
    this.lines[1].fill(0);
    for (const hart of this.harts) {
      hart.reset();
      hart.cycles = 0;
      hart.slept = 0;
      hart.trapCycles = 0;
    }
    for (const irq of this.irqs) irq.reset();
    this.running[0] = true;
    this.running[1] = true;
    this.baseNanos.fill(0);
    this.baseCycles.fill(0);
    this.nanosPerCycle = 1e9 / this.clocks.sysHz;
    this.codePages.fill(0);
    this.boot();
  }

  /** Why there is nothing the bootrom could run (the board would sit in BOOTSEL), or null. */
  bootError: string | null = null;
  /** The image the bootrom will enter (its IMAGE_DEF), once found. */
  image: ImageDef | null = null;

  /**
   * Both harts start at the bootrom's reset entry and the bootrom boots the flash image as on the
   * chip (≈ 15 ms of simulated time on the Pico 2's image layout). Checked first: an image the
   * bootrom couldn't run here halts with the reason instead (no image: BOOTSEL; an Arm image: it
   * would switch architectures through a watchdog reboot).
   */
  private boot(): void {
    try {
      this.image = findImageDef(this.flash);
      this.bootError = null;
    } catch (error) {
      if (!(error instanceof BootError)) throw error;
      this.image = null;
      this.bootError = error.message;
      this.running[0] = this.running[1] = false;
    }
  }

  /** clk_sys may have changed: keep each hart's time continuous at the new rate. */
  private rebase(): void {
    const hz = this.clocks.sysHz;
    if (!(hz > 0 && hz <= MAX_HZ)) return;
    for (let h = 0; h < 2; h++) {
      this.baseNanos[h] = this.hartNanos(h);
      this.baseCycles[h] = this.harts[h].cycles;
    }
    this.nanosPerCycle = 1e9 / hz;
  }

  // ── Running ─────────────────────────────────────────────────────────────────────────────

  /** Simulated time in reference cycles (150 MHz). */
  get cycles(): number {
    // While a hart runs, its own time: a pin it changes is stamped at its instruction.
    return Math.floor((this.now() * REFERENCE_HZ) / 1e9);
  }

  // ── Debugging (BT71): hart 0 ───────────────────────────────────────────────────────────

  /** Hart 0's breakpoints (byte addresses). While there are any, hart 0 runs checked. */
  readonly breakpoints = new Set<number>();
  /** The breakpoint hart 0 stopped at, which its next run executes unchecked (−1: none). */
  private resumePc = -1;
  /** The last run stopped at a breakpoint (the Mcu reads and clears it). */
  atBreakpoint = false;
  /** An alarm earlier than the slice's end arrived while a hart ran (onEarlier). */
  private cut = false;

  /**
   * Hart 0 up to `cycles` more, one instruction at a time, stopping before an instruction at a
   * breakpoint (true). Asleep in WFI it sleeps as usual; an interrupt it takes stops right after
   * the entry (`stopOnTrap`), so a breakpoint on a handler's first instruction is seen.
   */
  private runChecked(cycles: number): boolean {
    const hart = this.harts[0];
    const end = hart.cycles + cycles;
    hart.stopOnTrap = true;
    this.cut = false;
    try {
      while (hart.cycles < end && hart.halt === HALT.RUNNING && !this.cut) {
        const pc = hart.pc >>> 0;
        if (pc !== this.resumePc && this.breakpoints.has(pc)) {
          this.resumePc = pc;
          return true;
        }
        this.resumePc = -1;
        hart.run(hart.waiting ? end - hart.cycles : 1);
      }
      return false;
    } finally {
      hart.stopOnTrap = false;
    }
  }

  /**
   * One instruction on hart 0 (or, asleep, one cycle; an interrupt entry counts as the step),
   * then the rest of the SoC catches up to it.
   */
  stepHart0(): string | null {
    const hart = this.harts[0];
    if (this.bootError !== null) return this.bootError;
    if (!this.running[0] || hart.halt !== HALT.RUNNING) return 'hart 0 is halted';
    this.resumePc = -1;
    hart.stopOnTrap = true;
    this.active = 0;
    try {
      hart.run(1);
    } finally {
      hart.stopOnTrap = false;
      this.active = -1;
    }
    const halt = this.runUntilNanos(this.hartNanos(0));
    this.atBreakpoint = false;
    return halt;
  }

  /** Hart 0's time, ns (ahead of the SoC's clock after a step or a breakpoint). */
  get hart0Nanos(): number {
    return this.hartNanos(0);
  }

  /** One byte as the bus would read it, without side effects: memory, else a block's stored register, else 0. */
  peek(addr: number): number {
    addr >>>= 0;
    try {
      switch (addr >>> 28) {
        case 0x0:
        case 0x1:
        case 0x2:
          return this.read(0, addr, 1);
        case 0x4:
        case 0x5: {
          if ((addr >= BOOTRAM_BASE && addr < BOOTRAM_BASE + BOOTRAM_SIZE) || (addr >= DPRAM_BASE && addr < DPRAM_BASE + DPRAM_SIZE)) return this.read(0, addr, 1);
          const block = this.blocks.get(addr >>> 14);
          return block === undefined ? 0 : (block.peek(addr & 0xffc) >>> ((addr & 3) * 8)) & 0xff;
        }
        default:
          return 0;
      }
    } catch {
      return 0;
    }
  }

  /** Writes one byte of RAM (SRAM, the XIP cache as SRAM, BOOTRAM); false elsewhere. */
  poke(addr: number, value: number): boolean {
    addr >>>= 0;
    const ram = (addr >= SRAM_BASE && addr < SRAM_TOP) || (addr >= XIP_SRAM_BASE && addr < XIP_SRAM_BASE + XIP_SRAM_SIZE) || (addr >= BOOTRAM_BASE && addr < BOOTRAM_BASE + BOOTRAM_SIZE);
    if (!ram) return false;
    this.write(0, addr, value & 0xff, 1);
    this.invalidate(addr, 1);
    return true;
  }

  /** Runs until `targetNanos`; returns a halt message or null (`atBreakpoint` says whether hart 0 stopped at one). */
  runUntilNanos(targetNanos: number): string | null {
    if (this.bootError !== null) return this.bootError;
    const clock = this.clock;
    while (clock.nanos < targetNanos) {
      const sliceStart = clock.nanos;
      const end = Math.min(targetNanos, clock.nextAt, clock.nanos + (this.pioBusy() ? PIO_SLICE_NANOS : SLICE_NANOS));
      let reached = Infinity;
      for (let h = 0; h < 2; h++) {
        if (!this.running[h]) continue;
        const hart = this.harts[h];
        const behind = end - this.hartNanos(h);
        if (behind > 0) {
          this.active = h;
          this.sliceEnd = end;
          const cycles = Math.max(1, Math.ceil(behind / this.nanosPerCycle));
          if (h === 0 && this.breakpoints.size > 0) {
            if (this.runChecked(cycles)) {
              // Stopped before the breakpoint's instruction: the SoC catches up to hart 0.
              this.sliceEnd = Infinity;
              this.active = -1;
              const until = Math.max(clock.nanos, Math.min(this.hartNanos(0), targetNanos));
              if (this.pioOn()) this.pumpPio(sliceStart, until);
              clock.tickTo(until);
              this.atBreakpoint = true;
              return null;
            }
          } else hart.run(cycles);
          this.sliceEnd = Infinity;
          if (hart.halt !== HALT.RUNNING) return `hart ${h}: ${hart.haltReason || (hart.halt === HALT.BREAK ? 'EBREAK' : 'halted')} at 0x${(hart.pc >>> 0).toString(16)}`;
        }
        reached = Math.min(reached, this.hartNanos(h));
      }
      this.active = -1;
      const until = Math.max(clock.nanos, Math.min(reached, targetNanos));
      if (this.pioOn()) this.pumpPio(sliceStart, until);
      clock.tickTo(until);
    }
    return null;
  }

  // ── The bus ─────────────────────────────────────────────────────────────────────────────

  read(hart: number, addr: number, size: number): number {
    switch (addr >>> 28) {
      case 0x0:
        if (addr < ROM_SIZE) return size === 4 ? this.rom32[addr >>> 2] : size === 2 ? this.rom16[addr >>> 1] : this.rom[addr];
        break;
      case 0x1: {
        if (addr >= XIP_SRAM_BASE && addr < XIP_SRAM_BASE + XIP_SRAM_SIZE) {
          const o = addr - XIP_SRAM_BASE;
          return size === 4 ? this.xip32[o >>> 2] : size === 2 ? this.xip16[o >>> 1] : this.xipSram[o];
        }
        const window = (addr >>> 24) & 0xf;
        if (window === 0x0 || window === 0x4 || window === 0xc) {
          const o = addr & (FLASH_SIZE - 1);
          return size === 4 ? this.flash32[o >>> 2] : size === 2 ? this.flash16[o >>> 1] : this.flash[o];
        }
        if (window === 0x1 || window === 0x5 || window === 0xd || window === 0x8) return 0; // no PSRAM; maintenance
        break;
      }
      case 0x2:
        if (addr < SRAM_TOP) {
          const o = addr - SRAM_BASE;
          return size === 4 ? this.sram32[o >>> 2] : size === 2 ? this.sram16[o >>> 1] : this.sram[o];
        }
        break;
      case 0x4:
      case 0x5: {
        if (addr >= BOOTRAM_BASE && addr < BOOTRAM_BASE + BOOTRAM_SIZE) {
          const o = addr - BOOTRAM_BASE;
          return size === 4 ? this.boot32[o >>> 2] : size === 2 ? this.boot16[o >>> 1] : this.bootram[o];
        }
        if (addr >= DPRAM_BASE && addr < DPRAM_BASE + DPRAM_SIZE) {
          const o = addr - DPRAM_BASE;
          return size === 4 ? this.dpram32[o >>> 2] : size === 2 ? this.dpram16[o >>> 1] : this.dpram[o];
        }
        if (addr >= OTP_DATA_BASE && addr < OTP_DATA_BASE + 0x10000) return 0; // unprogrammed OTP
        const block = this.blocks.get(addr >>> 14);
        if (block === undefined) break;
        const word = block.read(addr & 0xffc);
        return size === 4 ? word : size === 2 ? (word >>> ((addr & 2) * 8)) & 0xffff : (word >>> ((addr & 3) * 8)) & 0xff;
      }
      case 0xd:
        if ((addr & 0xfffdf000) >>> 0 === 0xd0000000) {
          const word = this.sio.read(hart, addr & 0xffc);
          return size === 4 ? word >>> 0 : size === 2 ? (word >>> ((addr & 2) * 8)) & 0xffff : (word >>> ((addr & 3) * 8)) & 0xff;
        }
        break;
    }
    throw new RiscvBusError(`read of ${size} bytes`, addr);
  }

  write(hart: number, addr: number, value: number, size: number): void {
    switch (addr >>> 28) {
      case 0x0:
        // The ROM ignores writes (no fault): varmulet's PUSH ends with a dummy write-back to 0.
        if (addr < ROM_SIZE) return;
        break;
      case 0x1: {
        if (addr >= XIP_SRAM_BASE && addr < XIP_SRAM_BASE + XIP_SRAM_SIZE) {
          const o = addr - XIP_SRAM_BASE;
          if (size === 4) this.xip32[o >>> 2] = value;
          else if (size === 2) this.xip16[o >>> 1] = value;
          else this.xipSram[o] = value;
          this.invalidate(addr, size);
          return;
        }
        const window = (addr >>> 24) & 0xf;
        if (window === 0x1 || window === 0x5 || window === 0xd || window === 0x8 || window === 0x9 || window === 0xa || window === 0xb) return; // no PSRAM; maintenance
        break;
      }
      case 0x2:
        if (addr < SRAM_TOP) {
          const o = addr - SRAM_BASE;
          if (size === 4) this.sram32[o >>> 2] = value;
          else if (size === 2) this.sram16[o >>> 1] = value;
          else this.sram[o] = value;
          if (this.codePages[o >>> 12] !== 0) this.invalidate(addr, size);
          return;
        }
        break;
      case 0x4:
      case 0x5: {
        if (addr >= BOOTRAM_BASE && addr < BOOTRAM_BASE + BOOTRAM_SIZE) {
          const o = addr - BOOTRAM_BASE;
          if (size === 4) this.boot32[o >>> 2] = value;
          else if (size === 2) this.boot16[o >>> 1] = value;
          else this.bootram[o] = value;
          return;
        }
        if (addr >= DPRAM_BASE && addr < DPRAM_BASE + DPRAM_SIZE) {
          const o = addr - DPRAM_BASE;
          if (size === 4) this.dpram32[o >>> 2] = value;
          else if (size === 2) this.dpram16[o >>> 1] = value;
          else this.dpram[o] = value;
          // The USB controller watches its buffer control words (rp2040js: DPRAMUpdated).
          this.usb?.DPRAMUpdated(o & ~3, this.dpram32[o >>> 2]);
          return;
        }
        const block = this.blocks.get(addr >>> 14);
        if (block === undefined) break;
        const word = size === 4 ? value : size === 2 ? (value & 0xffff) * 0x10001 : (value & 0xff) * 0x1010101;
        block.write(addr & 0xffc, word >>> 0, (addr >>> 12) & 3);
        return;
      }
      case 0xd:
        if ((addr & 0xfffdf000) >>> 0 === 0xd0000000) {
          const word = size === 4 ? value : size === 2 ? (value & 0xffff) * 0x10001 : (value & 0xff) * 0x1010101;
          this.sio.write(hart, addr & 0xffc, word >>> 0);
          return;
        }
        break;
    }
    throw new RiscvBusError(`write of ${size} bytes`, addr);
  }

  fetch16(addr: number): number {
    if (addr < ROM_SIZE) return this.rom16[addr >>> 1];
    if (addr >>> 28 === 0x1) {
      if (addr >= XIP_SRAM_BASE && addr < XIP_SRAM_BASE + XIP_SRAM_SIZE) return this.xip16[(addr - XIP_SRAM_BASE) >>> 1];
      const window = (addr >>> 24) & 0xf;
      if (window === 0x0 || window === 0x4 || window === 0xc) return this.flash16[(addr & (FLASH_SIZE - 1)) >>> 1];
    }
    if (addr >= SRAM_BASE && addr < SRAM_TOP) return this.sram16[(addr - SRAM_BASE) >>> 1];
    throw new RiscvBusError('instruction fetch', addr);
  }

  codePage(address: number): boolean {
    if (address < ROM_SIZE) return true;
    if (address >>> 28 === 0x1) {
      const window = (address >>> 24) & 0xf;
      return (window === 0x0 || window === 0x4 || window === 0xc) && !(address >= XIP_SRAM_BASE);
    }
    if (address >= SRAM_BASE && address < SRAM_TOP) {
      this.codePages[(address - SRAM_BASE) >>> 12] = 1;
      return true;
    }
    return false;
  }

  /** A write into memory a hart may have predecoded. */
  private invalidate(addr: number, size: number): void {
    this.harts[0].invalidateCode(addr, size);
    this.harts[1].invalidateCode(addr, size);
  }

  /** Flash contents changed (programming, a new image): drop predecoded flash code. */
  flashChanged(): void {
    for (const hart of this.harts) hart.icache.invalidateAll();
  }

  /** What drives GPIO `n` now. */
  drive(n: number, out: PinDrive): void {
    const word = n >>> 5;
    const bit = n & 31;
    const sioOut = ((word === 0 ? this.sio.gpioOut : this.sio.gpioHiOut) >>> bit) & 1;
    const sioOe = ((word === 0 ? this.sio.gpioOe : this.sio.gpioHiOe) >>> bit) & 1;
    this.io.drive(n, sioOut, sioOe, this.pads.pad(n), out);
  }

  /** The bench drives GPIO `n`'s input. */
  setInput(n: number, level: number): void {
    if (n >= GPIO_COUNT) return;
    const word = n >>> 5;
    const bit = 1 << (n & 31);
    this.inputs[word] = level !== 0 ? this.inputs[word] | bit : this.inputs[word] & ~bit;
    this.io.setInput(n, level);
  }
}
