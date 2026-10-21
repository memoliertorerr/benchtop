/**
 * Test helpers other packages reuse (`@benchtop/core/testing`): a scripted fake MCU and small
 * builders for bench environments and project documents. DOM-free like the rest of core.
 * Production code must not import this file.
 */

import type { BenchEnv } from './bench/bench.ts';
import type { I2cController, I2cDevice, SpiController, SpiDevice } from './contracts/bus.ts';
import type { FirmwareImage, Mcu, McuPin, PinMode, RunResult, UartPort } from './contracts/mcu.ts';
import type { BoardSpec, PartDefinition, PartProps, PinDef } from './contracts/part.ts';
import type { ProjectDoc } from './contracts/project.ts';
import type { Level, NetState } from './contracts/signal.ts';

/** One scripted event of a `FakeMcu`, at an absolute cycle. Steps must be in cycle order. */
export interface FakeStep {
  cycle: number;
  /** Pin whose mode and/or level changes. */
  pin?: string;
  mode?: PinMode;
  level?: Level;
  /** Bytes UART 0 transmits at this cycle. */
  tx?: readonly number[];
  /** Stop here, returning this from `runUntil`. */
  stop?: RunResult;
}

/** Steps that make `pin` an output and toggle it `count` times, `period` cycles apart. */
export function toggleSteps(pin: string, first: number, period: number, count: number, startLevel: Level = 1): FakeStep[] {
  const steps: FakeStep[] = [];
  let level = startLevel;
  for (let i = 0; i < count; i++) {
    steps.push({ cycle: first + i * period, pin, mode: 'output', level });
    level = level === 1 ? 0 : 1;
  }
  return steps;
}

/** A `McuPin` a test can set and inspect. */
export class FakeMcuPin implements McuPin {
  readonly id: string;
  /** Every state the bench reported through `setInput`, copied. */
  readonly inputs: NetState[] = [];
  private currentMode: PinMode = 'input';
  private level: Level = 0;
  private volts: number | undefined = undefined;
  private readonly listeners: (() => void)[] = [];

  constructor(id: string) {
    this.id = id;
  }

  mode(): PinMode {
    return this.currentMode;
  }

  outputLevel(): Level {
    return this.level;
  }

  outputVolts(): number | undefined {
    return this.volts;
  }

  /** An analog output (a DAC) at `volts`, or none (undefined); listeners fire. */
  setVolts(volts: number | undefined): void {
    this.volts = volts;
    for (const listener of this.listeners) listener();
  }

  setInput(state: NetState): void {
    this.inputs.push({ ...state });
  }

  onOutputChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Changes mode and/or level; listeners fire only on an actual change. */
  set(mode: PinMode | undefined, level: Level | undefined): void {
    const nextMode = mode ?? this.currentMode;
    const nextLevel = level ?? this.level;
    if (nextMode === this.currentMode && nextLevel === this.level) return;
    this.currentMode = nextMode;
    this.level = nextLevel;
    for (const listener of this.listeners) listener();
  }

  /** The most recent input state, if any. */
  lastInput(): NetState | undefined {
    return this.inputs[this.inputs.length - 1];
  }
}

export class FakeUart implements UartPort {
  /** Bytes the bench delivered with `receive`. */
  readonly received: number[] = [];
  private readonly listeners: ((byte: number) => void)[] = [];

  onTransmit(listener: (byte: number) => void): void {
    this.listeners.push(listener);
  }

  receive(bytes: Uint8Array): void {
    this.received.push(...bytes);
  }

  transmit(byte: number): void {
    for (const listener of this.listeners) listener(byte);
  }
}

export class FakeI2cController implements I2cController {
  readonly attached: I2cDevice[] = [];
  private readonly sda: string;
  private readonly scl: string;

  constructor(sda: string, scl: string) {
    this.sda = sda;
    this.scl = scl;
  }

  pins(): { sda: string; scl: string } {
    return { sda: this.sda, scl: this.scl };
  }

  attach(device: I2cDevice): void {
    this.attached.push(device);
  }

  detach(device: I2cDevice): void {
    const i = this.attached.indexOf(device);
    if (i >= 0) this.attached.splice(i, 1);
  }
}

export class FakeSpiController implements SpiController {
  readonly attached: { device: SpiDevice; selected: () => boolean }[] = [];
  private readonly sck: string;
  private readonly mosi: string;
  private readonly miso: string;

  constructor(sck: string, mosi: string, miso: string) {
    this.sck = sck;
    this.mosi = mosi;
    this.miso = miso;
  }

  pins(): { sck: string; mosi: string; miso: string } {
    return { sck: this.sck, mosi: this.mosi, miso: this.miso };
  }

  attach(device: SpiDevice, selected: () => boolean): void {
    this.attached.push({ device, selected });
  }

  detach(device: SpiDevice): void {
    const i = this.attached.findIndex((a) => a.device === device);
    if (i >= 0) this.attached.splice(i, 1);
  }
}

export interface FakeMcuOptions {
  kind?: Mcu['kind'];
  clockHz?: number;
  /** Pin ids; every pin starts as an input at level 0. */
  pins: readonly string[];
  script?: readonly FakeStep[];
  i2c?: readonly { sda: string; scl: string }[];
  spi?: readonly { sck: string; mosi: string; miso: string }[];
}

/**
 * An `Mcu` that executes a script instead of firmware: at each step's cycle it changes a pin,
 * transmits bytes or stops. Between steps it just counts cycles, so `runUntil` lands exactly on
 * the target.
 */
export class FakeMcu implements Mcu {
  readonly kind: Mcu['kind'];
  readonly clockHz: number;
  readonly pins: ReadonlyMap<string, FakeMcuPin>;
  readonly uart0 = new FakeUart();
  readonly i2cControllers: FakeI2cController[];
  readonly spiControllers: FakeSpiController[];
  /** The last image passed to `load`. */
  loaded: FirmwareImage | null = null;
  resets = 0;
  private script: readonly FakeStep[];
  private next = 0;
  private cycleCount = 0;

  constructor(options: FakeMcuOptions) {
    this.kind = options.kind ?? 'atmega328p';
    this.clockHz = options.clockHz ?? 16_000_000;
    this.pins = new Map(options.pins.map((id) => [id, new FakeMcuPin(id)]));
    this.script = options.script ?? [];
    this.i2cControllers = (options.i2c ?? []).map((p) => new FakeI2cController(p.sda, p.scl));
    this.spiControllers = (options.spi ?? []).map((p) => new FakeSpiController(p.sck, p.mosi, p.miso));
  }

  get cycles(): number {
    return this.cycleCount;
  }

  /** Replaces the script (from cycle 0 after the next reset, or from the current step now). */
  setScript(script: readonly FakeStep[]): void {
    this.script = script;
    this.next = 0;
  }

  load(image: FirmwareImage): void {
    this.loaded = image;
    this.reset();
  }

  reset(): void {
    this.cycleCount = 0;
    this.next = 0;
    this.resets++;
    for (const pin of this.pins.values()) pin.set('input', 0);
  }

  runUntil(targetCycles: number): RunResult {
    while (this.next < this.script.length && this.script[this.next].cycle <= targetCycles) {
      const step = this.script[this.next++];
      if (step.cycle > this.cycleCount) this.cycleCount = step.cycle;
      if (step.pin !== undefined) {
        const pin = this.pins.get(step.pin);
        if (pin === undefined) throw new Error(`fake MCU has no pin ${step.pin}`);
        pin.set(step.mode, step.level);
      }
      if (step.tx !== undefined) for (const byte of step.tx) this.uart0.transmit(byte);
      if (step.stop !== undefined) return step.stop;
    }
    if (this.cycleCount < targetCycles) this.cycleCount = targetCycles;
    return { reason: 'target' };
  }

  uart(index: number): UartPort | undefined {
    return index === 0 ? this.uart0 : undefined;
  }

  i2c(index: number): I2cController | undefined {
    return this.i2cControllers[index];
  }

  spi(index: number): SpiController | undefined {
    return this.spiControllers[index];
  }
}

/**
 * A board definition for a fake MCU: one digital header pin per id (mapped to the MCU pin of
 * the same name) in a row 2.54 mm apart, plus a supply pin '5V' (or '3V3') and a 'GND' pin.
 */
export function fakeBoard(type: string, pinIds: readonly string[], mcu: BoardSpec['mcu'] = 'atmega328p'): PartDefinition {
  const supply = mcu === 'esp32' ? { name: '3V3', volts: 3.3 } : { name: '5V', volts: 5 };
  const pins: PinDef[] = pinIds.map((name, i) => ({ name, x: i * 2.54, y: 0, role: 'digital' }));
  pins.push({ name: supply.name, x: 0, y: 10, role: 'power', volts: supply.volts });
  pins.push({ name: 'GND', x: 2.54, y: 10, role: 'ground', volts: 0 });
  return {
    type,
    title: `Fake board (${type})`,
    category: 'boards',
    size: { w: Math.max(1, pinIds.length) * 2.54, h: 12 },
    pins,
    defaults: {},
    board: { mcu, pinMap: Object.fromEntries(pinIds.map((id) => [id, id])) },
  };
}

/** A `BenchEnv` over a list of definitions and an MCU factory (default: no MCUs). */
export function makeBenchEnv(
  definitions: readonly PartDefinition[],
  createMcu: (board: BoardSpec, partId: string) => Mcu | undefined = () => undefined,
): BenchEnv {
  const byType = new Map(definitions.map((d) => [d.type, d]));
  return { part: (type) => byType.get(type), createMcu };
}

/**
 * A project document from a compact description: parts as id → type, wires as
 * ['part:pin', 'part:pin'] pairs, optional props per part id.
 */
export function testDoc(
  parts: Record<string, string>,
  wires: readonly (readonly [string, string])[] = [],
  props: Record<string, PartProps> = {},
): ProjectDoc {
  const ref = (end: string) => {
    const colon = end.indexOf(':');
    return { part: end.slice(0, colon), pin: end.slice(colon + 1) };
  };
  return {
    format: 1,
    name: 'test',
    parts: Object.entries(parts).map(([id, type], i) => ({ id, type, x: i * 20, y: 0, rotation: 0, props: props[id] ?? {} })),
    wires: wires.map(([from, to], i) => ({ id: `w${i}`, from: ref(from), to: ref(to), waypoints: [], color: 'green' })),
    firmware: {},
  };
}
