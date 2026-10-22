/**
 * The RP2040 `Mcu` (BT60) over rp2040js 1.4.0 (MIT, Wokwi): its Cortex-M0+ core 0 and
 * peripherals, with Benchtop's own bootrom (bootrom/), time base (clock.ts), pins, UARTs, USB
 * serial, I2C and SPI on the bench contracts. Core 1 isn't simulated (Later).
 *
 * Time: `cycles` count a 125 MHz reference clock (8 ns each) whatever clk_sys the firmware
 * programs; an instruction takes rp2040js's cycle count at clk_sys. While the core waits
 * (WFI/WFE) the loop skips to the next alarm, or to the target.
 *
 * Boot (what our bootrom leaves, in place of the real boot sequence): reset runs the ROM's reset
 * stub, which boots directly — for a flash image, VTOR = 0x10000100 (the vector table after the
 * 256-byte second stage, which isn't run: rp2040js serves XIP reads without an SSI setup) and SP
 * and PC from that table; for a RAM-only UF2, PC = its lowest address and SP = 0x20042000 (the
 * datasheet's §2.8.4.2: a RAM binary is entered at its start). Clocks are as rp2040js resets
 * them (clk_sys 125 MHz); the SDK's runtime init programs them anyway.
 *
 * Firmware: UF2 (family RP2040; flash 0x10000000–0x10FFFFFF, RAM 0x20000000–0x20041FFF) or ELF
 * (PT_LOAD segments at their physical addresses in flash or RAM). Flash keeps what the firmware
 * programs across resets, as on the board. A MicroPython sketch (BT63) runs on the stock
 * interpreter UF2 the options carry, put on the board over USB serial at every reset
 * (micropython.ts).
 */

import type { Debuggable, FirmwareImage, I2cController, Level, Mcu, McuDebug, McuPin, NetState, PinMode, Problem, RunResult, SpiController, UartPort } from '@benchtop/core';
import { describeFirmwareFormat, parseElf32, parseUf2, placeUf2, UF2_FAMILY } from '@benchtop/core';
import { type GPIOPin, RP2040 } from 'rp2040js';
import { I2cBridge, SpiBridge, UsbSerialBridge } from './bridges.ts';
import { runRomCall } from './bootrom/handlers.ts';
import { buildBootrom, ROM_SIZE } from './bootrom/layout.ts';
import { Rp2040Clock } from './clock.ts';
import { DualCore } from './core1.ts';
import { Rp2040Debug } from './debug.ts';
import { createFastCore, type FastCore, type StockCore } from './m0/fast-core.ts';
import { CODE_MICROPYTHON_INSTALL, CODE_MICROPYTHON_MISSING, MICROPYTHON_MISSING_MESSAGE, MicroPythonInstaller, type MicroPythonSketch } from './micropython.ts';

/** One PIO state machine (rp2040js exports the class only through its PIO block). */
type PioMachine = RP2040['pio'][number]['machines'][number];

/** A run that stopped before an instruction at a breakpoint (BT72). */
const BREAKPOINT: RunResult = Object.freeze({ reason: 'breakpoint' });

export const RP2040_CLOCK_HZ = 125_000_000;
const NANOS_PER_CYCLE = 1e9 / RP2040_CLOCK_HZ;
const FLASH_BASE = 0x10000000;
const FLASH_SIZE = 16 * 1024 * 1024;
const SRAM_BASE = 0x20000000;
const SRAM_SIZE = 264 * 1024;
const BOOT_STACK = 0x20042000;
/** GPIO input thresholds at IOVDD 3.3 V (datasheet §5.5.3: VIH ≥ 2.0 V, VIL ≤ 0.8 V); between them the level holds. */
const VIH = 2.0;
const VIL = 0.8;
const ADC_VREF = 3.3;
/** The temperature sensor's ADC input at 27 °C (datasheet §4.9.5: 0.706 V). */
const TEMPERATURE_VOLTS = 0.706;

// GPIO functions (datasheet §2.19.2).
const F_SPI = 1;
const F_UART = 2;
const F_PWM = 4;
const F_SIO = 5;
const F_PIO0 = 6;
const F_PIO1 = 7;
const F_NULL = 0x1f;

const bootrom = buildBootrom();

/** The loaded image: what goes into flash and RAM, and where execution starts. */
interface LoadedImage {
  flash: { address: number; data: Uint8Array }[];
  sram: { address: number; data: Uint8Array }[];
  /** Flash binary: undefined (vector table at 0x10000100); RAM binary: its lowest address. */
  ramEntry: number | undefined;
}

class Rp2040Pin implements McuPin {
  readonly id: string;
  readonly index: number;
  private readonly mcu: Rp2040Mcu;
  readonly listeners: (() => void)[] = [];
  /** The last level applied (the Schmitt trigger's state). */
  inputLevel = false;
  volts = 0;
  constructor(mcu: Rp2040Mcu, index: number) {
    this.mcu = mcu;
    this.index = index;
    this.id = `GPIO${index}`;
  }

  private get gpio(): GPIOPin {
    return this.mcu.rp.gpio[this.index];
  }

  mode(): PinMode {
    const g = this.gpio;
    const fn = g.functionSelect;
    if (fn === F_SIO || fn === F_PWM || fn === F_PIO0 || fn === F_PIO1) {
      if (g.outputEnable) return fn === F_SIO ? 'output' : 'peripheral';
    } else if (fn === F_UART) {
      const role = this.index & 3; // TX, RX, CTS, RTS
      if (role === 0 || role === 3) return 'peripheral';
    } else if (fn === F_SPI) {
      if ((this.index & 3) !== 0) return 'peripheral'; // CSn, SCK, TX drive; RX listens
    } else if (fn === F_NULL && this.index >= 26 && !g.inputEnable) return 'analog';
    if (g.pullupEnabled && g.pulldownEnabled) return 'input';
    if (g.pullupEnabled) return 'input-pullup';
    if (g.pulldownEnabled) return 'input-pulldown';
    return 'input';
  }

  outputLevel(): Level {
    const g = this.gpio;
    const fn = g.functionSelect;
    if (fn === F_UART) return 1; // TX/RTS idle high (bytes travel at byte level)
    if (fn === F_SPI) return (this.index & 3) === 1 ? 1 : 0; // CSn high, SCK/TX low between bytes
    return g.outputValue ? 1 : 0;
  }

  setInput(state: NetState): void {
    this.volts = state.volts;
    let level = this.inputLevel;
    if (state.level === null) level = false;
    else if (state.volts >= VIH) level = true;
    else if (state.volts <= VIL) level = false;
    this.inputLevel = level;
    this.apply();
  }

  /** Pushes the input level and, on GPIO26–29, the ADC input to the current chip. */
  apply(): void {
    this.gpio.setInputValue(this.inputLevel);
    if (this.index >= 26) {
      const code = Math.round((Math.max(0, Math.min(ADC_VREF, this.volts)) / ADC_VREF) * 4095);
      this.mcu.rp.adc.channelValues[this.index - 26] = code;
    }
  }

  onOutputChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  fire(): void {
    for (const listener of this.listeners) listener();
  }
}

/** UART0/UART1 as a bench UartPort; bytes the bench sends reach RX at the configured baud. */
class Rp2040Uart implements UartPort {
  private readonly mcu: Rp2040Mcu;
  readonly index: number;
  readonly listeners: ((byte: number) => void)[] = [];
  private readonly queue: number[] = [];
  private alarm: { schedule(n: number): void; cancel(): void } | null = null;
  constructor(mcu: Rp2040Mcu, index: number) {
    this.mcu = mcu;
    this.index = index;
  }

  /** Wires the current chip's UART (after every reset). */
  wire(): void {
    const uart = this.mcu.rp.uart[this.index];
    uart.onByte = (byte) => {
      for (const listener of this.listeners) listener(byte);
    };
    this.queue.length = 0;
    this.alarm = this.mcu.clock.createAlarm(() => this.deliver());
  }

  onTransmit(listener: (byte: number) => void): void {
    this.listeners.push(listener);
  }

  receive(bytes: Uint8Array): void {
    const idle = this.queue.length === 0;
    for (const b of bytes) this.queue.push(b);
    if (idle && this.queue.length > 0) this.alarm?.schedule(this.byteNanos());
  }

  private byteNanos(): number {
    const baud = this.mcu.rp.uart[this.index].baudRate;
    return baud > 0 && Number.isFinite(baud) ? 10e9 / baud : 86_806; // 10 bits; 115200 when unset
  }

  private deliver(): void {
    const byte = this.queue.shift();
    if (byte === undefined) return;
    this.mcu.rp.uart[this.index].feedByte(byte);
    if (this.queue.length > 0) this.alarm?.schedule(this.byteNanos());
  }

  pins(): { tx?: string; rx?: string } {
    const result: { tx?: string; rx?: string } = {};
    const gpio = this.mcu.rp.gpio;
    for (let n = 0; n < 30; n++) {
      if (gpio[n].functionSelect !== F_UART || (((n + 4) >> 3) & 1) !== this.index) continue;
      if ((n & 3) === 0) result.tx ??= `GPIO${n}`;
      else if ((n & 3) === 1) result.rx ??= `GPIO${n}`;
    }
    return result;
  }

  baud(): number | undefined {
    const uart = this.mcu.rp.uart[this.index];
    return uart.enabled ? Math.round(uart.baudRate) : undefined;
  }
}




export interface Rp2040McuOptions {
  /** Problems the chip reports (unimplemented registers, a reset into BOOTSEL, a fault). */
  onProblem?: (problem: Problem) => void;
  /**
   * BT63: the stock MicroPython UF2 (micropython-manifest.ts' MICROPYTHON_PICO), which runs a
   * `{ format: 'micropython' }` sketch. Without it such a sketch reports `micropython-missing`.
   */
  micropython?: Uint8Array;
  /** BT75: 'stock' keeps rp2040js's own core (the lockstep test's reference); default the fast one. */
  core?: 'fast' | 'stock';
}

export class Rp2040Mcu implements Mcu, Debuggable {
  readonly kind = 'rp2040' as const;
  readonly clockHz = RP2040_CLOCK_HZ;
  readonly pins: ReadonlyMap<string, McuPin>;
  /** The current chip (a new one after every reset). */
  rp: RP2040;
  clock: Rp2040Clock;
  onProblem: ((problem: Problem) => void) | null;
  private readonly pinList: Rp2040Pin[] = [];
  private readonly usb: UsbSerialBridge;
  private readonly uarts: Rp2040Uart[];
  private readonly i2cs: I2cBridge[];
  private readonly spis: SpiBridge[];
  private image: LoadedImage | null = null;
  /** BT63: the interpreter UF2, and the MicroPython sketch it runs (null: native firmware). */
  private readonly micropython: Uint8Array | undefined;
  private sketch: MicroPythonSketch | null = null;
  /** BT75: run the predecoded core (rp2040js's own when false). */
  private readonly fastCore: boolean;
  /** Flash as the firmware left it: survives resets. */
  private flash = new Uint8Array(FLASH_SIZE).fill(0xff);
  private nanosPerCycle = 1e9 / 125e6;
  /** Extra cycles the current ROM call charged. */
  private charged = 0;
  /** BT80: core 1 and the per-core state rp2040js keeps once (set by every new chip). */
  dual!: DualCore;
  /** BT80: core 1's own time, ns (it runs behind core 0, never ahead). */
  private core1Nanos = 0;
  private haltReason: RunResult | null = null;
  /** Per PIO state machine (PIO0 SM0–3, PIO1 SM0–3): clk_sys cycles until its next step. */
  private readonly pioWait = new Float64Array(8);
  /** The current chip's eight state machines, in pioWait's order. */
  private pioMachines: PioMachine[] = [];
  /**
   * Bit per state machine: it stepped (so checked what it waits on) since the core last ran,
   * the bench last called runUntil and the last alarm (`pioEpoch`, the clock's `fired` then).
   */
  private pioFresh = 0;
  private pioEpoch = -1;

  constructor(options: Rp2040McuOptions = {}) {
    this.onProblem = options.onProblem ?? null;
    this.micropython = options.micropython;
    this.fastCore = options.core !== 'stock';
    const pins = new Map<string, McuPin>();
    for (let n = 0; n < 30; n++) {
      const pin = new Rp2040Pin(this, n);
      this.pinList.push(pin);
      pins.set(pin.id, pin);
    }
    this.pins = pins;
    this.usb = new UsbSerialBridge(() => this.rp.usbCtrl, () => this.clock);
    this.uarts = [new Rp2040Uart(this, 0), new Rp2040Uart(this, 1)];
    const gpio = { count: 30, funcsel: (n: number) => this.rp.gpio[n].functionSelect };
    this.i2cs = [new I2cBridge(0, () => this.rp.i2c[0], gpio), new I2cBridge(1, () => this.rp.i2c[1], gpio)];
    this.spis = [new SpiBridge(0, () => this.rp.spi[0], gpio), new SpiBridge(1, () => this.rp.spi[1], gpio)];
    this.clock = this.newClock();
    this.rp = this.newChip();
  }

  get cycles(): number {
    return Math.floor(this.clock.nanos / NANOS_PER_CYCLE);
  }

  load(image: FirmwareImage): void {
    if (image.format === 'micropython') {
      this.sketch = image;
      this.image = this.micropython === undefined ? null : loadImage({ format: 'uf2', bytes: this.micropython });
    } else {
      this.sketch = null;
      this.image = loadImage(image);
    }
    this.flashImage();
    this.reset();
  }

  /**
   * Hardware reset. A MicroPython sketch starts from the interpreter's image with an empty
   * filesystem each time and is written again over USB serial (micropython.ts), so main.py runs
   * with the serial monitor attached, as an IDE's Run does.
   */
  reset(): void {
    if (this.sketch !== null) this.flashImage();
    this.clock = this.newClock();
    this.haltReason = null;
    this.charged = 0;
    this.rp = this.newChip();
    for (const pin of this.pinList) pin.apply();
    if (this.sketch !== null && this.image === null) {
      this.problem('error', CODE_MICROPYTHON_MISSING, MICROPYTHON_MISSING_MESSAGE);
      this.haltReason = { reason: 'halted', detail: MICROPYTHON_MISSING_MESSAGE };
    }
  }

  /** Flash as the image leaves it (erased elsewhere). */
  private flashImage(): void {
    this.flash.fill(0xff);
    for (const { address, data } of this.image?.flash ?? []) this.flash.set(data, address - FLASH_BASE);
  }

  /** A fresh chip: our bootrom, the persistent flash, RAM contents of a RAM image, every hook wired. */
  private newChip(): RP2040 {
    const rp = new RP2040(this.clock);
    // BT75: the predecoded core in place of rp2040js's, before anything resets or runs it.
    if (this.fastCore) (rp as { core: StockCore }).core = createFastCore(rp);
    rp.logger = {
      debug: () => {},
      info: () => {},
      // rp2040js reports registers it doesn't model (QSPI pads, XIP control, the voltage
      // regulator, some USB ones): information, not a fault of the circuit.
      warn: (component, message) => this.problem('info', 'rp2040-unimplemented', `${component}: ${message}`),
      error: (component, message) => this.problem('info', 'rp2040-unimplemented', `${component}: ${message}`),
    };
    rp.loadBootrom(bootrom.image); // resets the core (PC at our reset stub) and erases flash: put ours back
    if (this.flash !== undefined) rp.flash.set(this.flash);
    this.flash = rp.flash;
    for (const { address, data } of this.image?.sram ?? []) rp.sram.set(data, address - SRAM_BASE);
    rp.adc.channelValues[4] = Math.round((TEMPERATURE_VOLTS / ADC_VREF) * 4095);
    // BT80: core 1 — a second core of the same kind, its PPB, the FIFOs, the per-core SIO state.
    const Stock = (rp.core.constructor as unknown) as new (chip: RP2040) => StockCore;
    this.dual = new DualCore(rp, { createCore: () => (this.fastCore ? createFastCore(rp) : new Stock(rp)) });
    this.core1Nanos = 0;
    // rp2040js runs PIO from setTimeout, apart from simulated time: the run loop steps it instead.
    // A machine starting ends a batch (BT76): from then on PIO steps in time with the core.
    for (const pio of rp.pio) pio.run = () => this.cutBatch();
    this.pioWait.fill(0);
    this.pioMachines = rp.pio.flatMap((pio) => pio.machines);
    this.pioFresh = 0;
    this.pioEpoch = -1;
    rp.onBreak = (code) => this.onBreak(code);
    this.nanosPerCycle = 1e9 / rp.clkSys;
    this.clock.setRate(this.nanosPerCycle);
    rp.addClockListener((clkSys) => {
      this.nanosPerCycle = 1e9 / clkSys;
      this.clock.setRate(this.nanosPerCycle);
      this.dual.setClock(clkSys);
      this.cutBatch(); // its end was computed at the old rate
    });
    this.rp = rp;
    for (const pin of this.pinList) {
      const p = pin;
      rp.gpio[p.index].addListener(() => p.fire());
    }
    const sketch = this.sketch;
    this.usb.wire(
      sketch === null || this.image === null
        ? null
        : new MicroPythonInstaller(sketch, {
            send: (bytes) => this.usb.send(bytes),
            fail: (message) => this.problem('error', CODE_MICROPYTHON_INSTALL, message),
          }),
    );
    for (const uart of this.uarts) uart.wire();
    for (const i2c of this.i2cs) i2c.wire();
    for (const spi of this.spis) spi.wire();
    return rp;
  }

  runUntil(targetCycles: number): RunResult {
    if (this.haltReason !== null) return this.haltReason;
    if (this.image === null) return { reason: 'halted', detail: 'no firmware loaded' };
    const clock = this.clock;
    const core = this.rp.core;
    const [pio0, pio1] = this.rp.pio;
    const targetNanos = targetCycles * NANOS_PER_CYCLE;
    this.usb.flush();
    this.pioFresh = 0; // the bench may have changed an input a machine waits on
    try {
      while (clock.nanos < targetNanos) {
        const pioOn = !pio0.stopped || !pio1.stopped;
        const dual = this.dual.launched;
        if (core.waiting) wake(core);
        if (dual && this.fastCore && !pioOn && this.breakpointCount === 0) {
          // BT81: both cores batched, in slices.
          this.runSlice(targetNanos);
          if (this.haltReason !== null) return this.haltReason;
          continue;
        }
        if (core.waiting) {
          if (dual && this.core1Awake()) {
            // BT80: core 0 sleeps, core 1 runs — time follows core 1.
            const cycles = this.stepCore1();
            if (pioOn) {
              this.pioFresh = 0;
              this.pumpPio(cycles, false);
            }
            clock.advance(cycles);
            this.core1Nanos = clock.nanos;
            if (this.haltReason !== null) return this.haltReason;
            continue;
          }
          if (pioOn) this.idlePio(targetNanos);
          else clock.tickTo(Math.min(clock.nextAt, targetNanos));
          clock.anchorHere();
          this.core1Nanos = clock.nanos;
          continue;
        }
        if (this.breakpointCount !== 0) {
          if (this.atBreakpoint()) return BREAKPOINT;
        } else if (!pioOn && this.fastCore && !dual) {
          // BT76: no PIO, no breakpoint — many instructions up to the next alarm in one go.
          this.runBatch(Math.min(targetNanos, clock.nextAt));
          if (this.haltReason !== null) return this.haltReason;
          continue;
        }
        const cycles = core.executeInstruction() + this.charged;
        this.charged = 0;
        if (pioOn) {
          this.pioFresh = 0;
          this.pumpPio(cycles, false);
        }
        clock.advance(cycles);
        if (dual) this.catchUpCore1();
        if (this.haltReason !== null) return this.haltReason;
      }
    } catch (error) {
      return this.halt('fault', error instanceof Error ? error.message : String(error));
    } finally {
      this.dual.switchTo(0);
    }
    return { reason: 'target' };
  }

  /** BT80: one instruction on core 1 (it is the executing core meanwhile); its cycles, ROM charge included. */
  private stepCore1(): number {
    const dual = this.dual;
    dual.switchTo(1);
    try {
      const cycles = dual.cores[1].executeInstruction() + this.charged;
      this.charged = 0;
      return cycles;
    } finally {
      dual.switchTo(0);
    }
  }

  /**
   * BT81: one slice of both cores — core 0 batched up to the slice's end (≤ 5 µs, never past the
   * next alarm or the target), then core 1 batched up to where core 0 got (or to the slice's end
   * when core 0 fell asleep in it). Both asleep: straight to the next alarm.
   */
  private runSlice(targetNanos: number): void {
    const clock = this.clock;
    const core0 = this.rp.core;
    const start = clock.nanos;
    if (core0.waiting && !this.core1Awake()) {
      clock.tickTo(Math.min(clock.nextAt, targetNanos));
      clock.anchorHere();
      this.core1Nanos = clock.nanos;
      return;
    }
    const end = Math.min(targetNanos, clock.nextAt, start + SLICE_NS);
    if (!core0.waiting) this.runBatch(end);
    if (this.haltReason !== null) return;
    // Core 0 asleep (from the start or since, inside the slice): time goes on to the slice's end.
    const until = core0.waiting ? Math.max(end, clock.nanos) : clock.nanos;
    this.runCore1(until);
    if (clock.nanos < until) {
      clock.tickTo(until);
      clock.anchorHere();
    }
  }

  /** BT81: core 1 batched up to `until` with its own time (the clock's side view); asleep, it just moves there. */
  private runCore1(until: number): void {
    const dual = this.dual;
    const clock = this.clock;
    while (this.core1Nanos < until && dual.launched && this.core1Awake() && this.haltReason === null) {
      const core = dual.cores[1] as FastCore;
      dual.switchTo(1);
      clock.beginSide(core, this.core1Nanos, until);
      try {
        core.runCycles(core.retired + Math.max(1, Math.ceil((until - this.core1Nanos) / this.nanosPerCycle)));
      } finally {
        const charged = this.charged; // a ROM call (its BKPT ends the batch)
        this.charged = 0;
        this.core1Nanos = clock.endSide(charged);
        dual.switchTo(0);
      }
    }
    if (!dual.launched || dual.cores[1].waiting) this.core1Nanos = Math.max(this.core1Nanos, until);
  }

  /** BT80: core 1 runs up to core 0's time (asleep, it just moves there). */
  private catchUpCore1(): void {
    const target = this.clock.nanos;
    if (this.fastCore) {
      this.runCore1(target);
      return;
    }
    const dual = this.dual;
    while (dual.launched && this.core1Awake() && this.core1Nanos < target) {
      this.core1Nanos += this.stepCore1() * this.nanosPerCycle;
      if (this.haltReason !== null) return;
    }
    if (!dual.launched || dual.cores[1].waiting) this.core1Nanos = target;
  }

  /** Core 1 isn't asleep — or a pending exception (its SysTick) just woke it. */
  private core1Awake(): boolean {
    const dual = this.dual;
    const core = dual.cores[1];
    if (!core.waiting) return true;
    if (!core.interruptsUpdated) return false;
    dual.switchTo(1);
    try {
      wake(core);
    } finally {
      dual.switchTo(0);
    }
    return !core.waiting;
  }

  /**
   * BT76: core 0 instruction after instruction until the clock reaches `limit` (the target or
   * the next alarm), the core sleeping, a halt or a cut — without a clock tick per instruction:
   * the clock follows the core's retired cycles (each instruction sees its own start time), then
   * the alarms due fire. The same instructions at the same times as the loop's one-at-a-time
   * path, at a fraction of its cost.
   */
  private runBatch(limit: number): void {
    const clock = this.clock;
    const core = this.rp.core as FastCore;
    const stop = core.retired + clock.cyclesUntil(limit);
    clock.beginBatch(core, limit);
    try {
      core.runCycles(stop);
    } finally {
      const charged = this.charged; // a ROM call (its BKPT ends the batch)
      this.charged = 0;
      clock.endBatch(charged);
    }
  }

  // ── Debugging (BT72): core 0 ───────────────────────────────────────────────────────────

  /** Core 0's breakpoints (byte addresses, bit 0 clear). */
  readonly breakpoints = new Set<number>();
  /** The breakpoint the last run stopped at, which the next one executes unchecked (−1: none). */
  private resumePc = -1;
  private debugView: Rp2040Debug | null = null;

  /** A clock whose earlier alarms end a batch (BT76). */
  private newClock(): Rp2040Clock {
    const clock = new Rp2040Clock();
    clock.onEarlier = () => this.cutBatch();
    return clock;
  }

  /** Ends a running batch after the instruction executing (no batch: nothing to do). */
  private cutBatch(): void {
    const rp = (this as { rp?: RP2040 }).rp; // undefined while the constructor builds the first clock
    if (rp !== undefined && this.fastCore) (rp.core as FastCore).cut();
  }

  private get breakpointCount(): number {
    return this.breakpoints.size;
  }

  /**
   * Whether core 0 is about to execute an instruction at a breakpoint. A pending interrupt is
   * taken first (as `executeInstruction` would), so a breakpoint on a handler's first
   * instruction is seen.
   */
  private atBreakpoint(): boolean {
    const core = this.rp.core;
    if (core.interruptsUpdated && core.checkForInterrupts()) core.waiting = false;
    const pc = (core.PC & ~1) >>> 0;
    if (pc !== this.resumePc && this.breakpoints.has(pc)) {
      this.resumePc = pc;
      return true;
    }
    this.resumePc = -1;
    return false;
  }

  /** BT72: core 0's debugger view. */
  debug(): McuDebug {
    this.debugView ??= new Rp2040Debug(this);
    return this.debugView;
  }

  /** One instruction on core 0 (asleep: up to the next alarm), PIO and the clock kept in time. */
  stepCore0(): RunResult {
    if (this.haltReason !== null) return this.haltReason;
    if (this.image === null) return { reason: 'halted', detail: 'no firmware loaded' };
    const clock = this.clock;
    const core = this.rp.core;
    const pioOn = !this.rp.pio[0].stopped || !this.rp.pio[1].stopped;
    this.resumePc = -1;
    try {
      if (core.waiting) wake(core);
      if (core.waiting) {
        if (this.dual.launched && this.core1Awake()) {
          // core 1 runs up to core 0's next alarm meanwhile (BT80)
          const end = clock.nextAt;
          while (this.core1Awake() && clock.nanos < end && core.waiting && this.haltReason === null) {
            const cycles = this.stepCore1();
            if (pioOn) this.pumpPio(cycles, false);
            clock.advance(cycles);
            this.core1Nanos = clock.nanos;
          }
          return this.haltReason ?? { reason: 'target' };
        }
        if (pioOn) this.idlePio(clock.nextAt);
        else clock.tickTo(clock.nextAt);
        clock.anchorHere();
        this.core1Nanos = clock.nanos;
        return { reason: 'target' };
      }
      const cycles = core.executeInstruction() + this.charged;
      this.charged = 0;
      if (pioOn) {
        this.pioFresh = 0;
        this.pumpPio(cycles, false);
      }
      clock.advance(cycles);
      if (this.dual.launched) this.catchUpCore1();
      return this.haltReason ?? { reason: 'target' };
    } catch (error) {
      return this.halt('fault', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Runs the PIO state machines through the next `cycles` of clk_sys: each executes its next
   * instruction once its wait (the instruction's cycles, delay included, × its clock divider)
   * has passed, all of them in time order with the clock moved to each step, so their pin
   * changes reach the bench at their own times — inside a long CPU instruction too (an
   * exception entry, a ROM call's charged cycles). With `untilWake` (the core sleeping) it stops
   * early once the core wakes or an alarm comes due inside the span. Returns the cycles covered.
   */
  private pumpPio(cycles: number, untilWake: boolean): number {
    const clock = this.clock;
    const wait = this.pioWait;
    const machines = this.pioMachines;
    const start = clock.nanos;
    const npc = this.nanosPerCycle;
    const end = start + cycles * npc;
    let span = cycles;
    for (;;) {
      let next = -1;
      for (let i = 0; i < 8; i++) {
        if (!machines[i].enabled) wait[i] = 0; // steps as soon as it is enabled
        else if (wait[i] <= span && (next < 0 || wait[i] < wait[next])) next = i;
      }
      if (next < 0) break;
      const at = wait[next];
      clock.tickTo(start + at * npc);
      const machine = machines[next];
      const before = machine.cycles;
      machine.step();
      const divider = machine.clockDivInt === 0 ? 65536 : machine.clockDivInt + machine.clockDivFrac / 256;
      wait[next] = at + Math.max(1, machine.cycles - before) * divider;
      this.rp.pio[next >> 2].checkChangedPins();
      if (clock.fired !== this.pioEpoch) {
        this.pioEpoch = clock.fired;
        this.pioFresh = 0;
      }
      this.pioFresh |= 1 << next;
      if (untilWake && (!this.rp.core.waiting || clock.nextAt < end || (machine.waiting && this.pioIdle()))) {
        span = at;
        break;
      }
    }
    for (let i = 0; i < 8; i++) if (machines[i].enabled) wait[i] -= span;
    return span;
  }

  /** Every running state machine is stalled and has checked its condition since anything could have changed it. */
  private pioIdle(): boolean {
    if (this.clock.fired !== this.pioEpoch) return false;
    for (let i = 0; i < 8; i++) {
      const machine = this.pioMachines[i];
      if (machine.enabled && (!machine.waiting || (this.pioFresh & (1 << i)) === 0)) return false;
    }
    return true;
  }

  /**
   * While the core sleeps and PIO runs: PIO steps up to the next alarm (or the target). Once
   * every running machine is stalled (waiting on a FIFO, a pin or an IRQ) and has looked at its
   * condition since the core last ran, nothing changes before that alarm: skip to it.
   */
  private idlePio(targetNanos: number): void {
    const clock = this.clock;
    const limit = Math.min(clock.nextAt, targetNanos);
    const span = (limit - clock.nanos) / this.nanosPerCycle;
    if (this.pioIdle()) {
      clock.tickTo(limit);
      for (let i = 0; i < 8; i++) this.pioWait[i] = Math.max(0, this.pioWait[i] - span);
      return;
    }
    if (this.pumpPio(span, true) === span) clock.tickTo(limit);
  }

  uart(index: number): UartPort | undefined {
    if (index === 0) return this.usb;
    return this.uarts[index - 1];
  }

  i2c(index: number): I2cController | undefined {
    return this.i2cs[index];
  }

  spi(index: number): SpiController | undefined {
    return this.spis[index];
  }

  private halt(reason: 'fault' | 'halted', detail: string): RunResult {
    this.haltReason = { reason, detail };
    if (reason === 'fault') this.problem('error', 'rp2040-fault', detail);
    return this.haltReason;
  }

  private problem(severity: Problem['severity'], code: string, message: string): void {
    this.onProblem?.({ severity, code, message, parts: [] });
  }

  /** A BKPT: a ROM call inside the bootrom, else a breakpoint with no debugger attached. */
  private onBreak(code: number): void {
    const core = this.rp.core;
    const pc = (core.PC - 2) >>> 0;
    if (pc < ROM_SIZE && code !== 0) {
      const handled = runRomCall(code, {
        rp2040: this.rp,
        charge: (cycles) => {
          this.charged += Math.max(0, cycles);
        },
        boot: () => this.boot(),
        fault: (message) => {
          this.halt('fault', message);
        },
        usbBoot: () => {
          this.problem('warning', 'rp2040-usb-boot', 'the firmware rebooted into BOOTSEL (USB boot) mode: the board waits for a UF2 there');
          this.halt('halted', 'rebooted into BOOTSEL mode');
        },
      });
      if (handled) return;
    }
    this.halt('fault', `BKPT #${code} at 0x${pc.toString(16).padStart(8, '0')} with no debugger attached (on the board: a HardFault)`);
  }

  /** The ROM's reset handler: direct boot of the loaded image. */
  private boot(): void {
    const rp = this.rp;
    const core = rp.core;
    const ramEntry = this.image?.ramEntry;
    if (ramEntry !== undefined) {
      core.SP = BOOT_STACK;
      core.PC = ramEntry & ~1;
      return;
    }
    const table = FLASH_BASE + 0x100;
    const sp = rp.readUint32(table);
    const pc = rp.readUint32(table + 4);
    const inSram = (a: number): boolean => a > SRAM_BASE && a <= SRAM_BASE + SRAM_SIZE;
    const inCode = (a: number): boolean => (a >= FLASH_BASE && a < FLASH_BASE + FLASH_SIZE) || (a >= SRAM_BASE && a < SRAM_BASE + SRAM_SIZE);
    if (!inSram(sp) || (pc & 1) === 0 || !inCode(pc & ~1)) {
      this.halt('halted', 'no program in flash: the board stays in BOOTSEL mode');
      return;
    }
    core.VTOR = table;
    core.SP = sp;
    core.PC = pc & ~1;
  }
}

/**
 * A sleeping core takes a pending exception now. `setInterrupt` wakes a core itself, but SysTick
 * and PendSV only set the core's pending flags (rp2040js), so the run loop asks before it lets a
 * core sleep on (BT80: core 1 waits in WFE with its SysTick running).
 */
function wake(core: StockCore): void {
  if (core.interruptsUpdated && core.checkForInterrupts()) core.waiting = false;
}

/** BT81: the longest stretch one core runs before the other catches up, ns. */
const SLICE_NS = 5_000;

/** Splits a firmware image into flash and RAM writes. Throws on anything that doesn't fit. */
function loadImage(image: FirmwareImage): LoadedImage {
  const flash: LoadedImage['flash'] = [];
  const sram: LoadedImage['sram'] = [];
  const place = (address: number, data: Uint8Array): void => {
    const end = address + data.length;
    if (address >= FLASH_BASE && end <= FLASH_BASE + FLASH_SIZE) flash.push({ address, data });
    else if (address >= SRAM_BASE && end <= SRAM_BASE + SRAM_SIZE) sram.push({ address, data });
    else throw new Error(`firmware data at 0x${address.toString(16)}–0x${(end - 1).toString(16)} is outside the RP2040's flash and RAM`);
  };
  if (image.format === 'uf2') {
    const uf2 = parseUf2(image.bytes);
    if (uf2.familyId !== undefined && uf2.familyId !== UF2_FAMILY.RP2040) throw new Error(`this UF2 is for family 0x${uf2.familyId.toString(16)}, not the RP2040 (0xe48bff56)`);
    uf2.blocks = uf2.blocks.filter((b) => b.family === undefined || b.family === UF2_FAMILY.RP2040);
    placeUf2(uf2, [{ start: FLASH_BASE, end: FLASH_BASE + FLASH_SIZE }, { start: SRAM_BASE, end: SRAM_BASE + SRAM_SIZE }], place);
  } else if (image.format === 'elf') {
    const elf = parseElf32(image.bytes);
    if (elf.machine !== 40) throw new Error(`this ELF is for machine ${elf.machine}, not ARM (40)`);
    for (const segment of elf.segments) if (segment.data.length > 0) place(segment.paddr, segment.data);
  } else throw new Error(`the RP2040 runs UF2 and ELF images (and MicroPython sketches); got ${describeFirmwareFormat(image.format)}`);
  if (flash.length === 0 && sram.length === 0) throw new Error('the image has no data to load');
  const ramEntry = flash.length === 0 ? Math.min(...sram.map((s) => s.address)) : undefined;
  return { flash, sram, ramEntry };
}

/** A fresh RP2040 for a board part. */
export function createRp2040Mcu(options: Rp2040McuOptions = {}): Rp2040Mcu {
  return new Rp2040Mcu(options);
}
