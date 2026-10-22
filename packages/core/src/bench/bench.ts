/**
 * The Bench: one circuit, running. It owns the netlist, the signal resolver, the part models,
 * the MCUs and the scheduler, and advances all of them on one simulated clock (ns).
 *
 * Core never imports the catalog or an MCU package: the caller injects both through `BenchEnv`.
 *
 * Time. `runUntil(t)` repeats: tNext = min(next timer, end of the current quantum, t); run every
 * MCU to tNext; fire the timers due at tNext. Quanta are aligned to multiples of the quantum
 * (1 ms with one MCU, 100 µs with several). While an MCU runs, `ctx.now()` is that MCU's own
 * cycle time, and its pin changes reach part listeners synchronously, so parts see exact edge
 * times. Between two MCUs, latency is at most one quantum. A timer a part schedules from inside
 * an MCU run fires at the end of that run; parts that must answer an edge quickly keep a timer
 * pending to shorten runs (RunSplitter in @benchtop/parts).
 *
 * Breakpoints. An MCU run that stops at a debugger breakpoint ends `runUntil` early: bench
 * time moves to that MCU's time (timers due by then fire), other MCUs keep where their quantum
 * took them, and the result names the board. The next `runUntil` resumes from there.
 *
 * Drivers. A pin whose `PinDef.volts` is defined drives its net at supply strength. Each board
 * header pin in `BoardSpec.pinMap` gets one driver that follows its `McuPin`: an analog output
 * (`outputVolts()` defined, a DAC) → strong at those volts; else output/peripheral → strong
 * `outputLevel()`, input-pullup → weak 1, input-pulldown → weak 0, input/analog → released. Part pins get a driver on first `drive`. Net changes reach MCU pins (`setInput`)
 * and part listeners; after build and after reset every one of them gets the current state once.
 *
 * Boards talking over a UART (BT39). Every byte an MCU's UART transmits goes to every UART —
 * of any MCU on the bench — whose RX pin (`UartPort.pins`) shares the TX pin's net or sits one
 * resistor away from it (a series resistor, a 5 V → 3.3 V divider). It's byte level, like each
 * MCU's own UART: the byte is handed to the receiver through the scheduler at the time the
 * sender reported it — causal, at most one quantum late — and the receiver frames it at its own
 * baud. avr8js reports a byte as its frame starts, so an Uno's byte reaches the other board's
 * FIFO one frame later, as on a wire; the ESP32 model reports at the stop bit, so its bytes
 * arrive one frame late. Rates more than 3 % apart are a `uart-baud-mismatch` warning; the
 * bytes still arrive (no garbling is modeled).
 *
 * Rebuilds that carry over (BT78). `carry()` ends a bench and hands the next one
 * (`BenchOptions.carry`) its time, its scheduler, its MCUs and its part models. A board whose
 * part id, MCU kind and firmware ref are unchanged keeps its MCU running (not loaded, not reset);
 * a part whose id, type and props, logic supply and analog role are unchanged keeps its model,
 * re-bound to its new nets: its pin listeners move there, its last drives and link settings are
 * re-applied, its bus devices re-attach. Everything else is built fresh — netlist, resolver,
 * analog layer, checks, environment — and the dropped parts' models are disposed and their
 * timers cancelled with the old bench's own (scheduler owner tags). While a carried bench
 * builds, net changes reach nobody; once it settled, every MCU pin and listener sees its net's
 * state once, so kept MCUs and models see the edit, not the build.
 *
 * The bus log (BT86). Every I2C and SPI device is attached through a logging proxy made once per
 * attachment (it records each call with `now()`, then forwards it); an SPI device's chip-select
 * edges come from a listener on its CS net; every byte a board's UART sends, or is handed
 * (`sendSerial`, a UART on the other board), is recorded too. `busLog()` holds them; a rebuilt
 * bench starts a new log.
 */

import { buildIslands } from '../analog/islands.ts';
import { BUS, BusLog, type BusSource } from '../bus-log/log.ts';
import { type CheckedBoardPin, type CheckedPart, DynamicChecks } from '../check/dynamic.ts';
import { staticProblems } from '../check/static.ts';
import { LEVEL_X, LEVEL_Z, MAX_PROBES, ProbeRing } from '../probe/ring.ts';
import { AnalogLayer, type DiodeInstance } from '../analog/layer.ts';
import { MAX_NODES } from '../analog/solve.ts';
import { ANALOG_PROP, type AnalogSpecFor } from '../analog/spec.ts';
import type { I2cController, I2cDevice, SpiController, SpiDevice } from '../contracts/bus.ts';
import { isDebuggable, type McuDebug } from '../contracts/debug.ts';
import type { FirmwareImage, Mcu, McuPin, UartPort } from '../contracts/mcu.ts';
import type {
  BoardSpec,
  LinkHandle,
  PartContext,
  PartDefinition,
  PartInput,
  PartModel,
  PinHandle,
  Problem,
  VisualState,
} from '../contracts/part.ts';
import type { FirmwareRef, ProjectDoc } from '../contracts/project.ts';
import { type Level, type NetState, Strength } from '../contracts/signal.ts';
import { cyclesToNanos, nanosToCycles, NS_PER_MS, NS_PER_US, type Nanos } from '../contracts/time.ts';
import { ENV_PERIOD_NS, EnvRuntime } from '../env/runtime.ts';
import type { EnvSpecFor, PointField } from '../env/spec.ts';
import { buildNetlist, type Netlist } from '../netlist/netlist.ts';
import { type ResolverLink, SignalResolver } from '../signals/resolver.ts';
import { Scheduler } from './scheduler.ts';
import { firmwareKey, propsKey } from './signature.ts';
import { type PartStorage, storageOf } from './storage.ts';

/** What the bench needs from outside core: part definitions and MCU implementations. */
/** How `runUntil`/`runFor` ended: at the requested time, or at a debugger breakpoint. */
export type BenchRunResult = { reason: 'target' } | { reason: 'breakpoint'; board: string };

const RUN_TARGET: BenchRunResult = Object.freeze({ reason: 'target' });

export interface BenchEnv {
  /** The definition of a part type, or undefined if the catalog has none. */
  part(type: string): PartDefinition | undefined;
  /**
   * A fresh MCU for a board part, or undefined if this environment has no implementation.
   * `report` puts a Problem on that board part (BT34: the ESP32 adapter's own Problems —
   * unknown registers, reboots, a missing ROM — which the Mcu contract has no channel for).
   */
  createMcu(board: BoardSpec, partId: string, report?: (problem: Problem) => void): Mcu | undefined;
}

export interface BenchOptions {
  /** ns between cross-MCU sync points. Default 1 ms with one MCU, 100 µs with several. */
  quantum?: Nanos;
  /**
   * Solve resistive islands for true voltages (BT21). Default true. Off, every net resolves at
   * switch level only.
   */
  analog?: boolean;
  /** Diodes (LEDs) per part type, for the analog layer; `@benchtop/parts` has `analogSpecFor`. */
  analogSpecFor?: AnalogSpecFor;
  /**
   * Environment roles per part type (BT54; `@benchtop/parts` has `envSpecFor`). With it, a
   * document holding an ambient part gets a world that feeds its sensors.
   */
  envSpecFor?: EnvSpecFor;
  /**
   * BT78: what the previous bench handed over (`Bench.carry()`): this bench starts at its time
   * and keeps its scheduler, unchanged boards' MCUs and unchanged parts' models.
   */
  carry?: BenchCarry;
  /**
   * BT79: boards to start afresh on a carried build even when they could carry over — new
   * firmware under an unchanged ref (the MCP server's `sim_update` with a board's firmware file).
   */
  restart?: readonly string[];
}

/** BT78: a bench's hand-over to the next one, from `Bench.carry()`. Opaque but for the time. */
export interface BenchCarry {
  /** Simulated time the next bench starts at, ns. */
  readonly time: Nanos;
  /** The rest is the bench's own. */
  readonly state: unknown;
}

/** What `BenchCarry.state` holds. */
interface CarryState {
  readonly scheduler: Scheduler;
  readonly boards: Map<string, CarriedMcu>;
  readonly parts: Map<string, PartBinding>;
  /** Every model handed over, for `discardCarry`. */
  readonly models: PartModel[];
}

interface CarriedMcu {
  readonly mcu: Mcu;
  readonly port: McuPort;
  readonly kind: BoardSpec['mcu'];
  readonly firmware: string;
  readonly base: Nanos;
  readonly stopped: { reason: string; detail: string } | null;
}

/**
 * BT78: disposes every part model a carry holds — for a caller whose next bench failed to build
 * (it rebuilds from scratch instead).
 */
export function discardCarry(carry: BenchCarry): void {
  for (const model of (carry.state as CarryState).models) {
    try {
      model.dispose?.();
    } catch {
      // a model that fails to let go is gone anyway
    }
  }
}

/** Visual state of the parts that called `invalidate()` since the previous frame. */
export interface Frame {
  /** Simulated time of the frame, ns. */
  t: Nanos;
  parts: [string, VisualState][];
}

/** UARTs per MCU the bench links over wires (BT39): the ESP32 has 3, the ATmega2560 4 (BT46). */
const MAX_UARTS = 4;
/** Logic supply of each MCU kind: what its output pins carry for level 1. */
export const MCU_LOGIC_VOLTS: Readonly<Record<BoardSpec['mcu'], number>> = { atmega328p: 5, atmega2560: 5, esp32: 3.3, rp2040: 3.3, rp2350: 3.3 };
/**
 * Internal pull-up/pull-down resistance per MCU, ohms (datasheet typicals; the analog layer). The
 * RP2040 and RP2350 datasheets give 50 kΩ (pad electrical specifications).
 */
export const MCU_PULL_OHMS: Readonly<Record<BoardSpec['mcu'], number>> = { atmega328p: 35_000, atmega2560: 35_000, esp32: 45_000, rp2040: 50_000, rp2350: 50_000 };
/** Logic supply assumed for a part whose power pin isn't on a powered net. */
export const DEFAULT_PART_VOLTS = 5;
/** I2C/SPI controller indexes probed per MCU when attaching devices. */
const MAX_BUS_INDEX = 4;
/** Timer callbacks in a row that may run without the clock advancing before the bench gives up. */
const MAX_STALLED_STEPS = 1_000_000;
const MAX_REPORTED = 1000;
/** Simulated time between dynamic circuit checks. */
const CHECK_INTERVAL_NS = 10 * NS_PER_MS;

interface PartSlot {
  readonly id: string;
  readonly def: PartDefinition;
  model: PartModel | null;
  logicVolts: number;
  dirty: boolean;
  /** The model's link to the bench (null without a model). */
  binding: PartBinding | null;
}

/** Scheduler owner tags of part bindings (0 is the bench's own). */
let nextOwner = 1;

/**
 * BT78: a part model's link to the bench it runs on — its context, handles and bus devices
 * route through it, so a rebuild that keeps the model re-points it (`bench`, `slot`) and the
 * handles, and the model never notices.
 */
interface PartBinding {
  bench: Bench;
  slot: PartSlot;
  /** Its timers' scheduler owner tag. */
  readonly owner: number;
  readonly type: string;
  /** The document props it was created with (`propsKey`), and whether it got the analog prop. */
  readonly props: string;
  readonly analog: boolean;
  readonly pins: Map<string, BenchPin>;
  readonly links: Map<string, BenchLink>;
  readonly i2c: { sda: string; scl: string; device: I2cDevice }[];
  readonly spi: { pins: { sck: string; mosi: string; miso: string; cs: string }; device: SpiDevice }[];
}

/**
 * A part's pin handle. BT78: a class with re-pointable fields — a kept model's handles follow it
 * to the next bench (`rebind`): its listeners are filed on the new net, its last drive re-applied.
 */
class BenchPin implements PinHandle {
  readonly name: string;
  private resolver: SignalResolver;
  private netListeners: (((state: NetState) => void)[] | undefined)[];
  private net: number;
  private logicVolts: number;
  private driver = -1;
  /** The last drive, re-applied on a rebuild: 0 none (or released), 1 a level, 2 volts. */
  private drove = 0;
  private level: Level = 0;
  private volts = 0;
  private strength: Strength = Strength.strong;
  private readonly listeners: ((state: NetState) => void)[] = [];

  constructor(name: string, resolver: SignalResolver, netListeners: (((state: NetState) => void)[] | undefined)[], net: number, logicVolts: number) {
    this.name = name;
    this.resolver = resolver;
    this.netListeners = netListeners;
    this.net = net;
    this.logicVolts = logicVolts;
  }

  read(): NetState {
    return this.resolver.state(this.net);
  }

  drive(level: Level, strength: Strength = Strength.strong): void {
    this.drove = 1;
    this.level = level;
    this.strength = strength;
    this.resolver.setDriver(this.driverId(), level, strength);
  }

  driveVolts(volts: number, strength: Strength = Strength.strong): void {
    this.drove = 2;
    this.volts = volts;
    this.strength = strength;
    this.resolver.setDriverVolts(this.driverId(), volts, strength);
  }

  release(): void {
    this.drove = 0;
    if (this.driver >= 0) this.resolver.releaseDriver(this.driver);
  }

  onChange(listener: (state: NetState) => void): void {
    this.listeners.push(listener);
    (this.netListeners[this.net] ??= []).push(listener);
  }

  /** On a new bench: its resolver and this pin's net there; listeners and the last drive follow. */
  rebind(resolver: SignalResolver, netListeners: (((state: NetState) => void)[] | undefined)[], net: number, logicVolts: number): void {
    this.resolver = resolver;
    this.netListeners = netListeners;
    this.net = net;
    this.logicVolts = logicVolts;
    this.driver = -1;
    for (const listener of this.listeners) (netListeners[net] ??= []).push(listener);
    if (this.drove === 1) resolver.setDriver(this.driverId(), this.level, this.strength);
    else if (this.drove === 2) resolver.setDriverVolts(this.driverId(), this.volts, this.strength);
  }

  private driverId(): number {
    return this.driver >= 0 ? this.driver : (this.driver = this.resolver.allocDriver(this.net, this.logicVolts));
  }
}

/** A part's link handle; BT78: re-pointable like `BenchPin`, its last setting re-applied. */
class BenchLink implements LinkHandle {
  private index: number;
  private resolver: SignalResolver;
  private analog: AnalogLayer | null;
  /** −1 never set, else 0 open / 1 closed. */
  private closed = -1;
  private ohms = Number.NaN;

  constructor(index: number, resolver: SignalResolver, analog: AnalogLayer | null) {
    this.index = index;
    this.resolver = resolver;
    this.analog = analog;
  }

  setClosed(closed: boolean): void {
    this.closed = closed ? 1 : 0;
    this.resolver.setLinkClosed(this.index, closed);
  }

  // Switch-level resolution ignores resistance; the analog layer re-solves the link's island.
  setOhms(ohms: number): void {
    if (ohms >= 0) this.ohms = ohms;
    const analog = this.analog;
    if (analog === null || !(ohms >= 0) || analog.linkOhms[this.index] === ohms) return;
    analog.linkOhms[this.index] = ohms;
    this.resolver.touchLink(this.index);
  }

  rebind(index: number, resolver: SignalResolver, analog: AnalogLayer | null): void {
    this.index = index;
    this.resolver = resolver;
    this.analog = analog;
    if (this.closed >= 0) resolver.setLinkClosed(index, this.closed === 1);
    if (!Number.isNaN(this.ohms)) this.setOhms(this.ohms);
  }
}

interface McuPinEntry {
  readonly pin: McuPin;
  readonly drivers: number[];
  readonly nets: number[];
  /** The resolver of the bench the MCU runs on now (BT78: re-pointed by a carried build). */
  resolver: SignalResolver;
  readonly apply: () => void;
  /** Header pins mapped to this MCU pin, for the dynamic checks' change counts. */
  readonly watched: CheckedBoardPin[];
}

/**
 * BT78: an MCU's side of its benches. `McuPin.onOutputChange` and `UartPort.onTransmit` have no
 * unsubscribe, so each MCU's listeners are registered once, here, and route to whichever bench
 * and slot run it now.
 */
interface McuPort {
  bench: Bench;
  slot: McuSlot | null;
  /** MCU pin id → its entry (drivers and nets on the current bench). */
  readonly entries: Map<string, McuPinEntry>;
  /** UART listeners registered. */
  hooked: boolean;
}

interface McuSlot {
  readonly partId: string;
  readonly mcu: Mcu;
  readonly port: McuPort;
  readonly kind: BoardSpec['mcu'];
  /** The board's firmware ref in this bench's document (`firmwareKey`). */
  readonly firmware: string;
  readonly clockHz: number;
  /** Bench time at which the MCU's cycle counter was 0. */
  base: Nanos;
  /** Why it stopped running, or null while it runs. */
  stopped: { reason: string; detail: string } | null;
  readonly pinEntries: McuPinEntry[];
  /** MCU pin id → the net of the first header pin mapped to it. */
  readonly netOfPin: Map<string, number>;
  serial: Uint8Array;
  serialLen: number;
  readonly serialListeners: ((bytes: Uint8Array) => void)[];
  /** The bus controllers' pins as last seen ("sda,scl" / "sck,mosi,miso"), by I2C then SPI index. */
  readonly busPins: string[];
  /** BT86: each UART port's bus-log sources (−1: no such port), TX then RX. */
  readonly uartTx: Int32Array;
  readonly uartRx: Int32Array;
}

/** BT86: an I2C device as its controller sees it — every call recorded, then forwarded. */
class LoggedI2c implements I2cDevice {
  private readonly inner: I2cDevice;
  private readonly bench: Bench;
  private readonly log: BusLog;
  readonly source: BusSource;

  constructor(inner: I2cDevice, bench: Bench, log: BusLog, source: BusSource) {
    this.inner = inner;
    this.bench = bench;
    this.log = log;
    this.source = source;
  }

  get address(): number {
    return this.inner.address;
  }

  start(read: boolean): boolean {
    const ack = this.inner.start(read);
    this.log.push(this.bench.now(), BUS.I2C_START, this.source.id, (this.inner.address & 0x7f) | (read ? 0x80 : 0), ack ? 1 : 0);
    return ack;
  }

  write(byte: number): boolean {
    const ack = this.inner.write(byte);
    this.log.push(this.bench.now(), BUS.I2C_WRITE, this.source.id, byte & 0xff, ack ? 1 : 0);
    return ack;
  }

  read(ack: boolean): number {
    const value = this.inner.read(ack);
    this.log.push(this.bench.now(), BUS.I2C_READ, this.source.id, value & 0xff, ack ? 1 : 0);
    return value;
  }

  stop(): void {
    this.inner.stop();
    this.log.push(this.bench.now(), BUS.I2C_STOP, this.source.id, 0, 0);
  }
}

/** BT86: an SPI device as its controller sees it. */
class LoggedSpi implements SpiDevice {
  private readonly inner: SpiDevice;
  private readonly bench: Bench;
  private readonly log: BusLog;
  readonly source: BusSource;

  constructor(inner: SpiDevice, bench: Bench, log: BusLog, source: BusSource) {
    this.inner = inner;
    this.bench = bench;
    this.log = log;
    this.source = source;
  }

  transfer(mosi: number): number {
    const miso = this.inner.transfer(mosi);
    this.log.push(this.bench.now(), BUS.SPI_XFER, this.source.id, mosi & 0xff, miso & 0xff);
    return miso;
  }
}

interface ProbeSlot {
  readonly net: number;
  readonly ring: ProbeRing;
  /** Last recorded level code (0, 1, 2 = z, 3 = x). */
  last: number;
}

/** A net state as a probe level: 0, 1, z (floating) or x (conflict). */
function levelCode(state: NetState): number {
  if (state.conflict) return LEVEL_X;
  return state.level === null ? LEVEL_Z : state.level;
}

interface I2cAttachment {
  readonly partId: string;
  readonly sda: number;
  readonly scl: number;
  readonly device: I2cDevice;
  /** What the controller gets (BT86). */
  readonly proxy: LoggedI2c;
}

interface SpiAttachment {
  readonly partId: string;
  readonly sck: number;
  readonly mosi: number;
  readonly miso: number;
  readonly cs: number;
  readonly device: SpiDevice;
  readonly proxy: LoggedSpi;
}

export class Bench {
  readonly netlist: Netlist;
  readonly quantum: Nanos;
  private readonly resolver: SignalResolver;
  private readonly scheduler: Scheduler;
  private time: Nanos = 0;
  /** BT78: building on a carry — net changes reach nobody until the bench settled. */
  private quiet = false;
  /** BT78: handed to another bench; this one can't run any more. */
  private carriedOver = false;
  /** Boards whose MCU came over from the previous bench, running. */
  private readonly keptBoards = new Set<string>();
  /** BT86: the I2C, SPI and UART traffic. */
  private readonly log = new BusLog();
  private current: McuSlot | null = null;
  /** The MCU whose run just stopped at a breakpoint (read and cleared by the run loop). */
  private breakSlot: McuSlot | null = null;
  private readonly parts = new Map<string, PartSlot>();
  private readonly partList: PartSlot[] = [];
  private readonly mcus: McuSlot[] = [];
  private readonly mcuByPart = new Map<string, McuSlot>();
  private readonly linkIndex = new Map<string, number>();
  /** Per net, the nets one resistive link away (UART bytes cross a series resistor or divider). */
  private readonly resistorNeighbors = new Map<number, number[]>();
  private readonly netMcuPins: (McuPin[] | undefined)[] = [];
  private readonly netListeners: (((state: NetState) => void)[] | undefined)[] = [];
  private readonly conflict: Uint8Array;
  private readonly buildProblems: Problem[] = [];
  private readonly reported = new Map<string, Problem>();
  private readonly i2c: I2cAttachment[] = [];
  /** Devices attached per I2C controller, in attach order (for address conflicts). */
  private readonly i2cBuses = new Map<I2cController, I2cAttachment[]>();
  /** Where each bus device is attached (so a re-route can detach it). */
  private readonly i2cAttached = new Map<I2cAttachment, I2cController>();
  private readonly spiAttached = new Map<SpiAttachment, SpiController>();
  private readonly spi: SpiAttachment[] = [];
  private readonly dirtyParts: PartSlot[] = [];
  private building = true;
  /** Inside runUntil (pins are configured by firmware by then). */
  private running = false;
  /** Board header pins and wired parts the dynamic checks watch. */
  private readonly checkedBoardPins: CheckedBoardPin[] = [];
  private readonly checks: DynamicChecks;
  private dynamicProblems: Problem[] = [];
  /** Probe id per net (−1 = none): the net-update path's only probe cost. */
  private readonly netProbe: Int32Array;
  private readonly probes: (ProbeSlot | null)[] = [];
  /** The analog layer, or null when off (or when the circuit has no resistive island). */
  private readonly analog: AnalogLayer | null = null;
  /** Parts with an AnalogSpec while the analog layer is on (they get the runtime analog prop). */
  private readonly analogParts = new Set<string>();
  /** Parts on a network too large to solve: their pins read switch-level volts. */
  private readonly switchLevelParts = new Set<string>();
  /** The environment (BT54), or null without an ambient part or `envSpecFor`. */
  private readonly env: EnvRuntime | null = null;

  constructor(doc: ProjectDoc, env: BenchEnv, options: BenchOptions = {}) {
    const carried = options.carry === undefined ? null : (options.carry.state as CarryState);
    this.scheduler = carried?.scheduler ?? new Scheduler();
    this.time = options.carry?.time ?? 0;
    this.quiet = carried !== null;

    // Topology.
    const defs = new Map<string, PartDefinition | undefined>();
    const defOf = (type: string): PartDefinition | undefined => {
      if (!defs.has(type)) defs.set(type, env.part(type));
      return defs.get(type);
    };
    this.netlist = buildNetlist(doc, {
      pins: (type) => defOf(type)?.pins.map((p) => p.name),
      buses: (type) => defOf(type)?.buses ?? [],
      geometry: (type) => {
        const def = defOf(type);
        return def === undefined ? undefined : { size: def.size, pins: def.pins };
      },
    });
    const netlist = this.netlist;
    for (const id of netlist.unknownParts) {
      const type = doc.parts.find((p) => p.id === id)?.type ?? '?';
      this.buildProblems.push(problem('error', 'unknown-part-type', `Part "${id}" has unknown type "${type}".`, [id]));
    }
    const docPartIds = new Set(doc.parts.map((p) => p.id));
    for (const end of netlist.unresolved) {
      this.buildProblems.push(
        problem('error', 'unresolved-wire', `Wire "${end.wire}" ends on ${end.ref.part}:${end.ref.pin}, which doesn't exist.`, docPartIds.has(end.ref.part) ? [end.ref.part] : []),
      );
    }

    // Links between nets, from each definition's LinkDefs.
    const links: ResolverLink[] = [];
    const linkOhms: number[] = [];
    for (const part of doc.parts) {
      const def = defOf(part.type);
      if (def === undefined) continue;
      for (const link of def.links ?? []) {
        const a = netlist.netOf(part.id, link.a);
        const b = netlist.netOf(part.id, link.b);
        if (a < 0 || b < 0) {
          this.buildProblems.push(problem('error', 'bad-part-definition', `Link "${link.id}" of "${part.type}" names a missing pin.`, [part.id]));
          continue;
        }
        this.linkIndex.set(`${part.id}\u0000${link.id}`, links.length);
        links.push({ a, b, kind: link.kind, closed: link.kind === 'resistive' ? true : link.closed === true });
        if (link.kind === 'resistive' && a !== b) {
          let near = this.resistorNeighbors.get(a);
          if (near === undefined) this.resistorNeighbors.set(a, (near = []));
          near.push(b);
          let back = this.resistorNeighbors.get(b);
          if (back === undefined) this.resistorNeighbors.set(b, (back = []));
          back.push(a);
        }
        linkOhms.push(link.ohms ?? 1000);
      }
    }
    this.conflict = new Uint8Array(netlist.netCount);
    this.netProbe = new Int32Array(netlist.netCount).fill(-1);
    this.resolver = new SignalResolver(netlist.netCount, links);
    this.resolver.onChange = this.netChanged;

    // Supply pins.
    for (const part of doc.parts) {
      for (const pin of defOf(part.type)?.pins ?? []) {
        if (pin.volts === undefined) continue;
        const net = netlist.netOf(part.id, pin.name);
        if (net < 0) continue;
        const id = this.resolver.allocDriver(net, pin.volts);
        this.resolver.setDriver(id, pin.volts > 0 ? 1 : 0, Strength.supply);
      }
    }

    // Analog islands: resistive and switch links plus the parts' diodes; supply nets are fixed.
    if (options.analog !== false) {
      const diodes: DiodeInstance[] = [];
      for (const part of doc.parts) {
        const def = defOf(part.type);
        if (def === undefined) continue;
        const spec = options.analogSpecFor?.(part.type, { ...def.defaults, ...part.props });
        if (spec === undefined) continue;
        this.analogParts.add(part.id);
        for (const diode of spec.diodes) {
          const anode = netlist.netOf(part.id, diode.anode);
          const cathode = netlist.netOf(part.id, diode.cathode);
          if (anode >= 0 && cathode >= 0) diodes.push({ anode, cathode, vf: diode.vf, rs: diode.rs });
        }
      }
      const resolver = this.resolver;
      const { islands, netIsland } = buildIslands({
        netCount: netlist.netCount,
        links,
        diodes: diodes.map((d) => ({ a: d.anode, b: d.cathode })),
        fixed: (net) => resolver.isFixed(net),
      });
      if (islands.length > 0) {
        const layer = new AnalogLayer(netlist.netCount, islands, netIsland, links, diodes);
        linkOhms.forEach((ohms, i) => (layer.linkOhms[i] = ohms));
        layer.tooLarge.forEach((large, i) => {
          if (large === 0) return;
          const pins = Array.from(islands[i].nets).flatMap((net) => netlist.pinsOfNet(net));
          for (const part of partsOf(pins)) this.switchLevelParts.add(part);
          this.buildProblems.push(
            problem(
              'warning',
              'analog-island-too-large',
              `A resistive network of ${islands[i].nets.length} nets is too large to solve (${MAX_NODES} max); it keeps switch-level values.`,
              partsOf(pins),
            ),
          );
        });
        // Only a pin reading digitally cares (an ADC input at mid-scale is what it is for).
        layer.onUndefinedLevel = (net, volts) => {
          // Not while building or before anything ran: firmware hasn't configured its pins yet.
          if (!this.running) return false;
          const reading = (this.netMcuPins[net] ?? []).some((pin) => {
            const mode = pin.mode();
            return mode === 'input' || mode === 'input-pullup' || mode === 'input-pulldown';
          });
          if (!reading) return false;
          const pins = netlist.pinsOfNet(net);
          const shown = pins.slice(0, 3).map((p) => `${p.part}:${p.pin}`).join(', ');
          this.report(problem('info', 'analog-undefined-level', `${shown} sits at ${volts.toFixed(2)} V, between a clear 0 and 1; the input keeps its last level.`, partsOf(pins)));
          return true;
        };
        layer.onNoConvergence = (island) => {
          const pins = Array.from(islands[island].nets).flatMap((net) => netlist.pinsOfNet(net));
          this.report(problem('warning', 'analog-no-convergence', 'The diodes in a resistive network did not settle in 20 rounds.', partsOf(pins)));
        };
        this.analog = layer;
        resolver.attachAnalog(layer);
      }
    }

    // MCUs on board parts: an unchanged board keeps its running MCU (BT78).
    for (const part of doc.parts) {
      const board = defOf(part.type)?.board;
      if (board === undefined) continue;
      const firmware = firmwareKey(doc.firmware[part.id] as FirmwareRef | undefined);
      const kept = carried?.boards.get(part.id);
      if (kept !== undefined && kept.kind === board.mcu && kept.firmware === firmware && options.restart?.includes(part.id) !== true) {
        carried?.boards.delete(part.id);
        this.keptBoards.add(part.id);
        this.addMcu(part.id, board, kept.mcu, kept.port, firmware, kept);
        continue;
      }
      let mcu: Mcu | undefined;
      const port: McuPort = { bench: this, slot: null, entries: new Map(), hooked: false };
      try {
        const id = part.id;
        mcu = env.createMcu(board, id, (p) => port.bench.report(p.parts.includes(id) ? p : { ...p, parts: [id, ...p.parts] }));
      } catch (error) {
        this.buildProblems.push(problem('error', 'mcu-unavailable', `Creating the ${board.mcu} for "${part.id}" failed: ${errorText(error)}`, [part.id]));
        continue;
      }
      if (mcu === undefined) {
        this.buildProblems.push(problem('error', 'mcu-unavailable', `No ${board.mcu} implementation for "${part.id}".`, [part.id]));
        continue;
      }
      this.addMcu(part.id, board, mcu, port, firmware, null);
    }
    this.quantum = options.quantum ?? (this.mcus.length > 1 ? 100 * NS_PER_US : NS_PER_MS);
    if (!(this.quantum > 0)) throw new RangeError(`quantum must be > 0, got ${this.quantum}`);

    // Part models. A part's logic supply is the voltage on its first consumer power pin.
    for (const part of doc.parts) {
      const def = defOf(part.type);
      if (def === undefined) continue;
      const slot: PartSlot = { id: part.id, def, model: null, logicVolts: DEFAULT_PART_VOLTS, dirty: false, binding: null };
      for (const pin of def.pins) {
        if (pin.role !== 'power' || pin.volts !== undefined) continue;
        const volts = this.resolver.state(netlist.netOf(part.id, pin.name)).volts;
        if (volts > 0) slot.logicVolts = volts;
        break;
      }
      this.parts.set(part.id, slot);
      this.partList.push(slot);
      if (def.createModel === undefined) continue;
      const analog = this.analogParts.has(part.id);
      const props = propsKey(part.props);
      const kept = carried?.parts.get(part.id);
      if (kept !== undefined && kept.type === part.type && kept.props === props && kept.analog === analog && kept.slot.logicVolts === slot.logicVolts && kept.slot.model !== null) {
        carried?.parts.delete(part.id);
        this.rebindPart(kept, slot);
        continue;
      }
      const binding: PartBinding = { bench: this, slot, owner: nextOwner++, type: part.type, props, analog, pins: new Map(), links: new Map(), i2c: [], spi: [] };
      slot.binding = binding;
      try {
        const merged = analog ? { ...def.defaults, ...part.props, [ANALOG_PROP]: true } : { ...def.defaults, ...part.props };
        slot.model = def.createModel(this.makeContext(binding), merged);
      } catch (error) {
        this.buildProblems.push(problem('error', 'part-model-error', `Part "${part.id}" failed to start: ${errorText(error)}`, [part.id]));
      }
    }
    if (carried !== null) {
      // What didn't carry over: the models go, and their timers with the old bench's own.
      const dropped = new Set<number>([0]);
      for (const binding of carried.parts.values()) {
        dropped.add(binding.owner);
        try {
          binding.slot.model?.dispose?.();
        } catch {
          // gone either way
        }
      }
      carried.parts.clear();
      carried.boards.clear();
      this.scheduler.cancelOwners((owner) => dropped.has(owner));
    }

    this.building = false;
    for (const attachment of this.i2c) this.attachI2cDevice(attachment);
    for (const attachment of this.spi) this.attachSpiDevice(attachment);
    for (const slot of this.mcus) this.checkBusPins(slot, false); // the pins those attachments saw
    this.quiet = false;
    this.syncAll();

    // Circuit checks: static ones now, dynamic ones every 10 ms of simulated time.
    const resolver = this.resolver;
    this.buildProblems.push(...staticProblems({ doc, defOf, netlist, supplyVolts: (net) => (resolver.isFixed(net) ? resolver.fixedVolts(net) : undefined) }));
    const checkedParts: CheckedPart[] = [];
    for (const part of doc.parts) {
      const def = defOf(part.type);
      if (def === undefined || def.board !== undefined || part.type.startsWith('breadboard')) continue;
      const nets = (role: 'power' | 'ground'): number[] =>
        def.pins
          .filter((pin) => pin.role === role && pin.volts === undefined)
          .map((pin) => netlist.netOf(part.id, pin.name))
          .filter((net) => net >= 0 && netlist.pinsOfNet(net).length > 1);
      const powerNets = nets('power');
      const groundNets = nets('ground');
      if (powerNets.length > 0 || groundNets.length > 0) checkedParts.push({ part: part.id, powerNets, groundNets });
    }
    this.checks = new DynamicChecks(this.checkedBoardPins, checkedParts, netlist, (net) => resolver.state(net), (net) => {
      const analog = this.analog;
      if (analog === null) return false;
      const island = analog.netIsland[net];
      return island >= 0 && analog.tooLarge[island] === 0;
    });
    this.scheduler.schedule(this.time + CHECK_INTERVAL_NS, this.checkTick);

    // The environment (BT54): a world feeding the sensors, when the document has an ambient part.
    if (options.envSpecFor !== undefined) {
      this.env = EnvRuntime.build(
        doc.parts,
        defOf,
        options.envSpecFor,
        {
          deliver: (partId, input) => this.parts.get(partId)?.model?.input?.(input),
          pinVolts: (partId, pin) => {
            const net = netlist.netOf(partId, pin);
            return net < 0 ? undefined : resolver.state(net).volts;
          },
          pinWired: (partId, pin) => {
            const net = netlist.netOf(partId, pin);
            return net >= 0 && netlist.pinsOfNet(net).length > 1;
          },
        },
        (ids) => this.buildProblems.push(problem('warning', 'environment-duplicate', 'Only the first environment part sets the room; the others do nothing.', ids)),
      );
      if (this.env !== null) {
        // A source's control input is optional: an unwired heater or lamp is normal.
        const env = this.env;
        for (let i = this.buildProblems.length - 1; i >= 0; i--) {
          const p = this.buildProblems[i];
          if (p.code === 'unwired-part' && p.parts.length === 1 && env.owns(p.parts[0])) this.buildProblems.splice(i, 1);
        }
        env.reset(this.time);
        this.scheduler.schedule(this.time + ENV_PERIOD_NS, this.envTick);
      }
    }
    // A carried bench isn't reset: every part shows its state in the next frame.
    if (carried !== null) for (const slot of this.partList) this.invalidate(slot);
  }

  /** Runs the dynamic checks and schedules the next run. */
  private readonly checkTick = (): void => {
    this.dynamicProblems = this.checks.run();
    this.scheduler.schedule(this.time + CHECK_INTERVAL_NS, this.checkTick);
  };

  /** Steps the environment, feeds its sensors and schedules the next period. */
  private readonly envTick = (): void => {
    const env = this.env;
    if (env === null) return;
    env.tick(this.time);
    this.scheduler.schedule(this.time + ENV_PERIOD_NS, this.envTick);
  };

  /** Current simulated time, ns: the running MCU's cycle time while one runs, else bench time. */
  now(): Nanos {
    const m = this.current;
    return m === null ? this.time : m.base + cyclesToNanos(m.mcu.cycles, m.clockHz);
  }

  /**
   * Advances everything to simulated time `t` (ns), or until an MCU stops at a breakpoint.
   * Earlier or equal times do nothing.
   */
  runUntil(t: Nanos): BenchRunResult {
    if (this.carriedOver) throw new Error('this bench was carried over to another');
    if (!(t > this.time)) return RUN_TARGET;
    this.running = true;
    try {
      return this.runLoop(t);
    } finally {
      this.running = false;
    }
  }

  /** `runUntil(now + ns)`. */
  runFor(ns: Nanos): BenchRunResult {
    return this.runUntil(this.time + ns);
  }

  private runLoop(t: Nanos): BenchRunResult {
    let stalled = 0;
    while (this.time < t) {
      const quantumEnd = (Math.floor(this.time / this.quantum) + 1) * this.quantum;
      let tNext = Math.min(this.scheduler.nextTime(), quantumEnd, t);
      if (tNext <= this.time) {
        // A timer is due now (scheduled from inside an MCU run that passed its time, or with
        // zero delay): fire it without advancing.
        tNext = this.time;
        if (++stalled > MAX_STALLED_STEPS) {
          this.report(problem('error', 'timer-storm', 'Timers keep firing without simulated time advancing.', []));
          this.scheduler.clear();
          return RUN_TARGET;
        }
      } else {
        stalled = 0;
        for (let i = 0; i < this.mcus.length; i++) this.runMcu(this.mcus[i], tNext);
        const hit = this.breakSlot;
        if (hit !== null) {
          // Stop at the breaking MCU's own time; timers due by then still fire.
          this.breakSlot = null;
          this.time = Math.min(tNext, Math.max(this.time, hit.base + cyclesToNanos(hit.mcu.cycles, hit.clockHz)));
          this.scheduler.runDue(this.time);
          this.flushSerial();
          return { reason: 'breakpoint', board: hit.partId };
        }
        this.time = tNext;
      }
      this.scheduler.runDue(tNext);
      if (tNext === quantumEnd || tNext === t) this.flushSerial();
    }
    return RUN_TARGET;
  }

  // ── Debugging ────────────────────────────────────────────────────────────────────────────

  /** Why a board's MCU stopped for good (`halted`, `fault`), or null while it can run. */
  mcuStopped(boardPartId: string): { reason: string; detail: string } | null {
    return this.mcuSlot(boardPartId).stopped;
  }

  /** A board's debugger view, or undefined when its MCU isn't debuggable. */
  debugOf(boardPartId: string): McuDebug | undefined {
    const mcu = this.mcuSlot(boardPartId).mcu;
    return isDebuggable(mcu) ? mcu.debug() : undefined;
  }

  /**
   * One instruction on one board, with its pin edges at its exact time; then the rest of the
   * bench (timers, other MCUs) catches up to it.
   */
  debugStep(boardPartId: string): BenchRunResult {
    const slot = this.mcuSlot(boardPartId);
    if (!isDebuggable(slot.mcu)) throw new Error(`the MCU on "${boardPartId}" has no debugger`);
    this.current = slot;
    try {
      const result = slot.mcu.debug().step();
      if (result.reason === 'halted' || result.reason === 'fault') slot.stopped = { reason: result.reason, detail: result.detail ?? '' };
    } finally {
      this.current = null;
    }
    return this.runUntil(slot.base + cyclesToNanos(slot.mcu.cycles, slot.clockHz));
  }

  /** Loads firmware into a board's MCU (which resets it) and restarts its clock at bench time. */
  attachFirmware(boardPartId: string, image: FirmwareImage): void {
    const slot = this.mcuSlot(boardPartId);
    slot.mcu.load(image);
    slot.base = this.time;
    slot.stopped = null;
    slot.serialLen = 0;
    this.syncMcu(slot);
  }

  /**
   * Resets the whole bench: time 0, every pending timer dropped, every MCU reset, every part
   * model's `reset()`, part problems cleared. Then every pin sees the current state once.
   */
  reset(): void {
    this.scheduler.clear();
    this.time = 0;
    this.resolver.clearOscillations();
    this.reported.clear();
    this.analog?.reset();
    this.checks.reset();
    this.dynamicProblems = [];
    for (const slot of this.mcus) {
      slot.mcu.reset();
      slot.base = 0;
      slot.stopped = null;
      slot.serialLen = 0;
    }
    for (const slot of this.partList) {
      slot.model?.reset?.();
      this.invalidate(slot);
    }
    for (const slot of this.mcus) for (const entry of slot.pinEntries) entry.apply();
    this.syncAll();
    this.scheduler.schedule(CHECK_INTERVAL_NS, this.checkTick);
    if (this.env !== null) {
      this.env.reset();
      this.scheduler.schedule(ENV_PERIOD_NS, this.envTick);
    }
    // Probes restart with time: the state at 0, then changes.
    for (const slot of this.probes) {
      if (slot === null) continue;
      slot.ring.clear();
      slot.last = levelCode(this.resolver.state(slot.net));
      slot.ring.push(0, slot.last);
    }
  }

  /** Delivers user or script input to a part's model. */
  input(partId: string, event: PartInput): void {
    const slot = this.parts.get(partId);
    if (slot === undefined) throw new Error(`no part "${partId}" on the bench`);
    if (this.env?.owns(partId)) this.env.input(partId, event);
    else slot.model?.input?.(event);
  }

  /**
   * The environment's value of a point field at a part's position (BT54), or undefined without
   * an environment or for a part it doesn't place (an ambient part, a part with no env role).
   */
  envSample(partId: string, field: PointField): number | undefined {
    return this.env?.sampleAt(partId, field);
  }

  /** True when the bench has an environment (an ambient part and `envSpecFor`). */
  get hasEnvironment(): boolean {
    return this.env !== null;
  }

  /** Receives a board's UART 0 output, in batches flushed at each quantum boundary. */
  onSerial(boardPartId: string, listener: (bytes: Uint8Array) => void): void {
    this.mcuSlot(boardPartId).serialListeners.push(listener);
  }

  /** Sends bytes to a board's UART 0 receiver. */
  sendSerial(boardPartId: string, bytes: Uint8Array): void {
    const slot = this.mcuSlot(boardPartId);
    slot.mcu.uart(0)?.receive(bytes);
    for (const byte of bytes) this.logUart(slot, 0, BUS.UART_RX, byte);
  }

  /**
   * BT89: the files a part holds (a microSD card's), or undefined when its model keeps none
   * (see storage.ts: a model carries `storage`).
   */
  storage(partId: string): PartStorage | undefined {
    const slot = this.parts.get(partId);
    return slot === undefined ? undefined : storageOf(slot.model);
  }

  /** BT86: the I2C, SPI and UART traffic this bench carried (`decodeBus` groups it). */
  busLog(): BusLog {
    return this.log;
  }

  /** A byte on a board's UART port, into the bus log. */
  private logUart(slot: McuSlot, port: number, kind: number, byte: number): void {
    const source = kind === BUS.UART_TX ? slot.uartTx[port] : slot.uartRx[port];
    if (source >= 0) this.log.push(this.now(), kind, source, byte & 0xff, 0);
  }

  /** Visual states of the parts that called `invalidate()` since the previous frame. */
  collectFrame(): Frame {
    const parts: [string, VisualState][] = [];
    const count = this.dirtyParts.length;
    for (let i = 0; i < count; i++) {
      const slot = this.dirtyParts[i];
      slot.dirty = false;
      const visual = slot.model?.visual?.();
      if (visual !== undefined) parts.push([slot.id, visual]);
    }
    this.dirtyParts.splice(0, count);
    this.env?.collect(parts, this.time);
    return { t: this.time, parts };
  }

  /** The resolved state of the net a part's pin sits on (a copy), or undefined for an unknown pin. */
  pinState(part: string, pin: string): NetState | undefined {
    const net = this.netlist.netOf(part, pin);
    if (net < 0) return undefined;
    const { level, strength, conflict, volts } = this.resolver.state(net);
    return { level, strength, conflict, volts };
  }

  /**
   * Everything wrong right now: build problems (unknown types, unresolved wire ends, missing
   * MCUs, unattached bus devices), shorts and oscillations mapped to parts, stopped MCUs, and
   * problems parts reported (kept until reset).
   */
  problems(): readonly Problem[] {
    const list = [...this.buildProblems];
    for (let net = 0; net < this.netlist.netCount; net++) {
      if (this.conflict[net] === 0) continue;
      const pins = this.netlist.pinsOfNet(net);
      const shown = pins.slice(0, 4).map((p) => `${p.part}:${p.pin}`).join(', ');
      // Against a supply it's an output driven into 5V/GND; between outputs, a short.
      if (this.resolver.isFixed(net)) {
        list.push(problem('error', 'drive-fight', `${shown}${pins.length > 4 ? ', …' : ''}: an output is driven against a supply.`, partsOf(pins)));
      } else {
        list.push(problem('error', 'short', `Short circuit: ${shown}${pins.length > 4 ? ', …' : ''} are driven to opposite levels.`, partsOf(pins)));
      }
    }
    const oscillating = this.resolver.oscillations();
    if (oscillating.length > 0) {
      const pins = oscillating.flatMap((net) => this.netlist.pinsOfNet(net));
      list.push(problem('error', 'oscillation', 'A zero-delay feedback loop never settled; it was cut off.', partsOf(pins)));
    }
    for (const slot of this.mcus) {
      if (slot.stopped === null) continue;
      const { reason, detail } = slot.stopped;
      list.push(
        problem(reason === 'fault' ? 'error' : 'info', `mcu-${reason}`, `The MCU on "${slot.partId}" stopped (${reason})${detail ? `: ${detail}` : '.'}`, [slot.partId]),
      );
    }
    list.push(...this.dynamicProblems);
    for (const p of this.reported.values()) {
      // An LED's current comes from its pins' volts; switch-level volts (5 V straight across
      // it) would claim an overcurrent the circuit doesn't have.
      if (p.code === 'led-overcurrent' && p.parts.length > 0 && p.parts.every((id) => this.switchLevelParts.has(id))) continue;
      list.push(p);
    }
    // One problem per code and part set; the newest message wins.
    const byKey = new Map<string, Problem>();
    for (const p of list) {
      const parts = [...p.parts].sort();
      const key = `${p.code}|${parts.join(',')}`;
      byKey.delete(key);
      byKey.set(key, { ...p, parts });
    }
    return [...byKey.values()];
  }

  /**
   * BT78: ends this bench and hands the next one (`BenchOptions.carry`) its time, scheduler,
   * MCUs and part models — which of them it keeps is the next bench's decision. Pending serial
   * output is flushed to this bench's listeners first; bus devices are detached from the MCUs'
   * controllers (the next bench attaches the kept ones again). Don't `dispose()` this bench
   * afterwards, and don't run it: it has nothing left.
   */
  carry(): BenchCarry {
    if (this.running) throw new Error('carry() inside a run');
    if (this.carriedOver) throw new Error('this bench was already carried over');
    this.flushSerial();
    for (const [attachment, controller] of this.i2cAttached) controller.detach(attachment.proxy);
    for (const [attachment, controller] of this.spiAttached) controller.detach(attachment.proxy);
    this.i2cAttached.clear();
    this.spiAttached.clear();
    this.i2cBuses.clear();
    const boards = new Map<string, CarriedMcu>();
    for (const slot of this.mcus) boards.set(slot.partId, { mcu: slot.mcu, port: slot.port, kind: slot.kind, firmware: slot.firmware, base: slot.base, stopped: slot.stopped });
    const parts = new Map<string, PartBinding>();
    const models: PartModel[] = [];
    for (const slot of this.partList) {
      if (slot.binding === null || slot.model === null) continue;
      parts.set(slot.id, slot.binding);
      models.push(slot.model);
    }
    this.carriedOver = true;
    const state: CarryState = { scheduler: this.scheduler, boards, parts, models };
    return { time: this.time, state };
  }

  /** BT78: whether a board's MCU came over running from the previous bench (no firmware load). */
  carriedBoard(boardPartId: string): boolean {
    return this.keptBoards.has(boardPartId);
  }

  /** Tears the bench down: every part model's `dispose()`. */
  dispose(): void {
    this.scheduler.clear();
    for (const slot of this.partList) slot.model?.dispose?.();
  }

  // ── Build ────────────────────────────────────────────────────────────────────────────────

  /** `kept`: the MCU came over running from the previous bench (BT78), with its time base. */
  private addMcu(partId: string, board: BoardSpec, mcu: Mcu, port: McuPort, firmware: string, kept: CarriedMcu | null): void {
    const slot: McuSlot = {
      partId,
      mcu,
      port,
      kind: board.mcu,
      firmware,
      clockHz: mcu.clockHz,
      // A new MCU starts from reset now (a rebuilt bench's time isn't 0).
      base: kept?.base ?? this.time,
      stopped: kept?.stopped ?? null,
      pinEntries: [],
      netOfPin: new Map(),
      serial: new Uint8Array(256),
      serialLen: 0,
      serialListeners: [],
      busPins: [],
      uartTx: new Int32Array(MAX_UARTS).fill(-1),
      uartRx: new Int32Array(MAX_UARTS).fill(-1),
    };
    for (let i = 0; i < MAX_UARTS; i++) {
      const uart = mcu.uart(i);
      if (uart === undefined) continue;
      const name = i === 0 ? 'Serial' : `Serial${i}`;
      const baud = (): number => uart.baud?.() ?? 0;
      slot.uartTx[i] = this.log.addSource({ bus: 'uart', board: partId, part: null, label: `${partId} ${name} TX`, baud, direction: 'tx' }).id;
      slot.uartRx[i] = this.log.addSource({ bus: 'uart', board: partId, part: null, label: `${partId} ${name} RX`, baud, direction: 'rx' }).id;
    }
    port.bench = this;
    port.slot = slot;
    const logicVolts = MCU_LOGIC_VOLTS[board.mcu];
    const pullOhms = MCU_PULL_OHMS[board.mcu];
    const entries = port.entries;
    for (const entry of entries.values()) {
      // A kept MCU's pins: their listeners stay, their drivers and nets are this bench's.
      entry.drivers.length = 0;
      entry.nets.length = 0;
      entry.watched.length = 0;
      entry.resolver = this.resolver;
    }
    for (const [header, pinId] of Object.entries(board.pinMap)) {
      const net = this.netlist.netOf(partId, header);
      const pin = mcu.pins.get(pinId);
      if (net < 0 || pin === undefined) {
        this.buildProblems.push(
          problem('error', 'bad-part-definition', `Board pin "${header}" → "${pinId}" doesn't exist on "${partId}".`, [partId]),
        );
        continue;
      }
      if (!slot.netOfPin.has(pinId)) slot.netOfPin.set(pinId, net);
      const checked: CheckedBoardPin = { board: partId, header, mcu: board.mcu, pin, net, vcc: logicVolts, changes: 0 };
      this.checkedBoardPins.push(checked);
      let entry = entries.get(pinId);
      if (entry === undefined) {
        const drivers: number[] = [];
        const watched: CheckedBoardPin[] = [];
        const created: McuPinEntry = {
          pin,
          drivers,
          nets: [],
          resolver: this.resolver,
          apply: (): void => {
            const resolver = created.resolver;
            for (let i = 0; i < watched.length; i++) watched[i].changes++;
            const mode = pin.mode();
            const volts = pin.outputVolts?.();
            for (let i = 0; i < drivers.length; i++) {
              const id = drivers[i];
              if (volts !== undefined) resolver.setDriverVolts(id, volts, Strength.strong);
              else if (mode === 'output' || mode === 'peripheral') resolver.setDriver(id, pin.outputLevel(), Strength.strong);
              else if (mode === 'input-pullup') resolver.setDriver(id, 1, Strength.weak);
              else if (mode === 'input-pulldown') resolver.setDriver(id, 0, Strength.weak);
              else resolver.releaseDriver(id);
            }
          },
          watched,
        };
        entry = created;
        entries.set(pinId, entry);
        pin.onOutputChange(entry.apply);
      }
      if (!slot.pinEntries.includes(entry)) slot.pinEntries.push(entry);
      entry.watched.push(checked);
      if (entry.nets.includes(net)) continue;
      entry.nets.push(net);
      entry.drivers.push(this.resolver.allocDriver(net, logicVolts, pullOhms));
      (this.netMcuPins[net] ??= []).push(pin);
      if (this.analog !== null) {
        this.analog.netVcc[net] = logicVolts;
        this.analog.netReader[net] = 1;
      }
    }
    if (!port.hooked) {
      // Once per MCU: the listeners follow the port to the bench and slot running it (BT78).
      port.hooked = true;
      mcu.uart(0)?.onTransmit((byte) => {
        const current = port.slot as McuSlot;
        if (current.serialLen === current.serial.length) {
          const bigger = new Uint8Array(current.serial.length * 2);
          bigger.set(current.serial);
          current.serial = bigger;
        }
        current.serial[current.serialLen++] = byte;
      });
      for (let i = 0; i < MAX_UARTS; i++) {
        const uart = mcu.uart(i);
        if (uart === undefined) continue;
        const index = i;
        uart.onTransmit((byte) => port.bench.logUart(port.slot as McuSlot, index, BUS.UART_TX, byte));
        if (uart.pins !== undefined) uart.onTransmit((byte) => port.bench.forwardUart(port.slot as McuSlot, uart, byte));
      }
    }
    this.mcus.push(slot);
    this.mcuByPart.set(partId, slot);
    for (const entry of slot.pinEntries) entry.apply();
  }

  /** The context a model gets: everything goes through its binding, so a carried model follows it (BT78). */
  private makeContext(binding: PartBinding): PartContext {
    return {
      now: () => binding.bench.now(),
      pin: (name) => {
        let handle = binding.pins.get(name);
        if (handle === undefined) {
          const bench = binding.bench;
          handle = new BenchPin(name, bench.resolver, bench.netListeners, bench.netOfPart(binding.slot.id, name), binding.slot.logicVolts);
          binding.pins.set(name, handle);
        }
        return handle;
      },
      link: (id) => {
        let handle = binding.links.get(id);
        if (handle === undefined) {
          const bench = binding.bench;
          handle = new BenchLink(bench.linkOf(binding.slot.id, id), bench.resolver, bench.analog);
          binding.links.set(id, handle);
        }
        return handle;
      },
      schedule: (delay, callback) => {
        if (Number.isNaN(delay)) throw new RangeError('timer delay is NaN');
        const bench = binding.bench;
        return bench.scheduler.schedule(bench.now() + Math.max(0, delay), callback, binding.owner);
      },
      cancel: (timerId) => binding.bench.scheduler.cancel(timerId),
      invalidate: () => binding.bench.invalidate(binding.slot),
      // A model can't know its own id, so the bench names it in every problem it reports.
      report: (p) => {
        const id = binding.slot.id;
        binding.bench.report(p.parts.includes(id) ? p : { ...p, parts: [id, ...p.parts] });
      },
      attachI2c: (sda, scl, device) => {
        binding.i2c.push({ sda, scl, device });
        binding.bench.addI2c(binding.slot.id, sda, scl, device);
      },
      attachSpi: (pins, device) => {
        binding.spi.push({ pins, device });
        binding.bench.addSpi(binding.slot.id, pins, device);
      },
    };
  }

  /** BT78: a model from the previous bench, on this one's nets: handles, links and bus devices follow. */
  private rebindPart(binding: PartBinding, slot: PartSlot): void {
    slot.model = binding.slot.model;
    slot.binding = binding;
    binding.bench = this;
    binding.slot = slot;
    for (const pin of binding.pins.values()) pin.rebind(this.resolver, this.netListeners, this.netOfPart(slot.id, pin.name), slot.logicVolts);
    for (const [id, link] of binding.links) link.rebind(this.linkOf(slot.id, id), this.resolver, this.analog);
    for (const a of binding.i2c) this.addI2c(slot.id, a.sda, a.scl, a.device);
    for (const a of binding.spi) this.addSpi(slot.id, a.pins, a.device);
  }

  private addI2c(partId: string, sda: string, scl: string, device: I2cDevice): void {
    const source = this.log.addSource({ bus: 'i2c', board: '', part: partId, label: `${partId} (I2C)` });
    const proxy = new LoggedI2c(device, this, this.log, source);
    const attachment: I2cAttachment = { partId, sda: this.netOfPart(partId, sda), scl: this.netOfPart(partId, scl), device, proxy };
    this.i2c.push(attachment);
    if (!this.building) this.attachI2cDevice(attachment);
  }

  private addSpi(partId: string, pins: { sck: string; mosi: string; miso: string; cs: string }, device: SpiDevice): void {
    const attachment: SpiAttachment = {
      partId,
      sck: this.netOfPart(partId, pins.sck),
      mosi: this.netOfPart(partId, pins.mosi),
      miso: this.netOfPart(partId, pins.miso),
      cs: this.netOfPart(partId, pins.cs),
      device,
      proxy: new LoggedSpi(device, this, this.log, this.log.addSource({ bus: 'spi', board: '', part: partId, label: `${partId} (SPI)` })),
    };
    // Its chip-select edges frame its transfers in the log.
    const log = this.log;
    const id = attachment.proxy.source.id;
    let selected = false;
    (this.netListeners[attachment.cs] ??= []).push((state) => {
      const low = state.level === 0;
      if (low === selected) return;
      selected = low;
      log.push(this.now(), low ? BUS.SPI_SELECT : BUS.SPI_DESELECT, id, 0, 0);
    });
    this.spi.push(attachment);
    if (!this.building) this.attachSpiDevice(attachment);
  }

  private linkOf(partId: string, linkId: string): number {
    const index = this.linkIndex.get(`${partId}\u0000${linkId}`);
    if (index === undefined) throw new Error(`part "${partId}" has no link "${linkId}"`);
    return index;
  }

  private netOfPart(partId: string, pin: string): number {
    const net = this.netlist.netOf(partId, pin);
    if (net < 0) throw new Error(`part "${partId}" has no pin "${pin}"`);
    return net;
  }

  private attachI2cDevice(attachment: I2cAttachment): void {
    for (const slot of this.mcus) {
      for (let index = 0; index < MAX_BUS_INDEX; index++) {
        const controller: I2cController | undefined = slot.mcu.i2c(index);
        if (controller === undefined) continue;
        const { sda, scl } = controller.pins();
        if (slot.netOfPin.get(sda) === attachment.sda && slot.netOfPin.get(scl) === attachment.scl) {
          let onBus = this.i2cBuses.get(controller);
          if (onBus === undefined) this.i2cBuses.set(controller, (onBus = []));
          // The controller answers with the first device attached at an address.
          const address = attachment.device.address;
          const first = onBus.find((other) => other.device.address === address);
          if (first !== undefined) {
            const hex = `0x${address.toString(16).padStart(2, '0')}`;
            this.buildProblems.push(
              problem(
                'error',
                'i2c-address-conflict',
                `"${first.partId}" and "${attachment.partId}" share I2C address ${hex}; only "${first.partId}" answers.`,
                [first.partId, attachment.partId],
              ),
            );
          }
          onBus.push(attachment);
          controller.attach(attachment.proxy);
          this.i2cAttached.set(attachment, controller);
          const source = attachment.proxy.source;
          source.board = slot.partId;
          source.label = `${attachment.partId} (I2C 0x${address.toString(16).padStart(2, '0')})`;
          this.log.renamed();
          return;
        }
      }
    }
    this.buildProblems.push(
      problem('info', 'i2c-unattached', `I2C device on "${attachment.partId}" is not on any controller's SDA/SCL.`, [attachment.partId]),
    );
  }

  private attachSpiDevice(attachment: SpiAttachment): void {
    for (const slot of this.mcus) {
      for (let index = 0; index < MAX_BUS_INDEX; index++) {
        const controller: SpiController | undefined = slot.mcu.spi(index);
        if (controller === undefined) continue;
        const { sck, mosi, miso } = controller.pins();
        const nets = slot.netOfPin;
        // A write-only device (a TFT, a shift register) may leave its MISO unwired (BT51): then
        // SCK and MOSI decide.
        const misoUnwired = this.netlist.pinsOfNet(attachment.miso).length <= 1;
        if (nets.get(sck) === attachment.sck && nets.get(mosi) === attachment.mosi && (misoUnwired || nets.get(miso) === attachment.miso)) {
          const cs = this.resolver.state(attachment.cs);
          controller.attach(attachment.proxy, () => cs.level === 0);
          this.spiAttached.set(attachment, controller);
          attachment.proxy.source.board = slot.partId;
          this.log.renamed();
          return;
        }
      }
    }
    this.buildProblems.push(
      problem('info', 'spi-unattached', `SPI device on "${attachment.partId}" is not on any controller's SCK/MOSI/MISO.`, [attachment.partId]),
    );
  }

  // ── Run ──────────────────────────────────────────────────────────────────────────────────

  private runMcu(slot: McuSlot, tNext: Nanos): void {
    if (slot.stopped !== null) return;
    const target = nanosToCycles(tNext - slot.base, slot.clockHz);
    if (slot.mcu.cycles >= target) return;
    this.current = slot;
    try {
      const result = slot.mcu.runUntil(target);
      if (result.reason === 'breakpoint') this.breakSlot = slot;
      else if (result.reason !== 'target') slot.stopped = { reason: result.reason, detail: result.detail ?? '' };
    } finally {
      this.current = null;
    }
    if (this.i2c.length + this.spi.length > 0) this.checkBusPins(slot);
  }

  /**
   * An MCU may route its buses at run time (the ESP32's Wire.begin(sda, scl) goes through the
   * GPIO matrix): when a controller's pins differ from what they were at the last check, every
   * bus device is attached again by the usual net match. Checked after each MCU run, so a
   * re-route takes effect at the next quantum boundary (≤ 1 ms, 100 µs with several MCUs).
   */
  private checkBusPins(slot: McuSlot, rebind = true): void {
    let changed = false;
    for (let index = 0; index < MAX_BUS_INDEX; index++) {
      const i2c = slot.mcu.i2c(index);
      if (i2c !== undefined) {
        const p = i2c.pins();
        const key = `${p.sda},${p.scl}`;
        if (slot.busPins[index] !== key) {
          slot.busPins[index] = key;
          changed = true;
        }
      }
      const spi = slot.mcu.spi(index);
      if (spi !== undefined) {
        const p = spi.pins();
        const key = `${p.sck},${p.mosi},${p.miso}`;
        if (slot.busPins[MAX_BUS_INDEX + index] !== key) {
          slot.busPins[MAX_BUS_INDEX + index] = key;
          changed = true;
        }
      }
    }
    if (changed && rebind) this.rebindBuses();
  }

  /** Detaches every bus device and attaches it again where its nets now meet a controller. */
  private rebindBuses(): void {
    for (const [attachment, controller] of this.i2cAttached) controller.detach(attachment.proxy);
    for (const [attachment, controller] of this.spiAttached) controller.detach(attachment.proxy);
    this.i2cAttached.clear();
    this.spiAttached.clear();
    this.i2cBuses.clear();
    for (let i = this.buildProblems.length - 1; i >= 0; i--) {
      const code = this.buildProblems[i].code;
      if (code === 'i2c-unattached' || code === 'spi-unattached' || code === 'i2c-address-conflict') this.buildProblems.splice(i, 1);
    }
    for (const attachment of this.i2c) this.attachI2cDevice(attachment);
    for (const attachment of this.spi) this.attachSpiDevice(attachment);
  }

  /** The resolver's change callback: fan out to MCU pins and part listeners. Allocation-free. */
  /**
   * Called with every net whose resolved state changed, after its pins and listeners saw it
   * (debugging and tests: traces, probes). The state object is reused: copy what you keep.
   */
  netWatcher: ((net: number, state: NetState) => void) | null = null;

  // ── Probes (logic analyzer) ──────────────────────────────────────────────────────────────

  /**
   * Starts recording a pin's net: the state now, then every level change with its exact time.
   * Probing a pin probes its net; a second probe on the same net returns the first's id.
   * Returns −1 for an unknown pin or when MAX_PROBES are in use.
   */
  addProbe(pin: { part: string; pin: string }): number {
    const net = this.netlist.netOf(pin.part, pin.pin);
    if (net < 0) return -1;
    if (this.netProbe[net] >= 0) return this.netProbe[net];
    let id = this.probes.indexOf(null);
    if (id < 0) {
      if (this.probes.length >= MAX_PROBES) return -1;
      id = this.probes.length;
      this.probes.push(null);
    }
    const code = levelCode(this.resolver.state(net));
    const slot: ProbeSlot = { net, ring: new ProbeRing(), last: code };
    slot.ring.push(this.now(), code);
    this.probes[id] = slot;
    this.netProbe[net] = id;
    return id;
  }

  removeProbe(id: number): void {
    const slot = this.probes[id];
    if (slot === undefined || slot === null) return;
    this.netProbe[slot.net] = -1;
    this.probes[id] = null;
  }

  /** A probe's edges from absolute index `since` (at most `max`, the newest). */
  readProbe(id: number, since: number, max?: number): { from: number; times: Float64Array; levels: Uint8Array; lost: number } | undefined {
    const slot = this.probes[id];
    if (slot === undefined || slot === null) return undefined;
    return slot.ring.read(since, max);
  }

  /** Whether a probed net is driven by a peripheral the simulation doesn't draw (UART TX …). */
  probePeripheral(id: number): boolean {
    const slot = this.probes[id];
    if (slot === undefined || slot === null) return false;
    return (this.netMcuPins[slot.net] ?? []).some((pin) => pin.mode() === 'peripheral');
  }

  /** Whether a net belongs to a resolved analog island (its volts come from the solver). */
  isAnalogNet(net: number): boolean {
    return this.analog !== null && this.analog.netIsland[net] >= 0;
  }

  /** Whether an MCU pin sits on the net. */
  netHasMcuPin(net: number): boolean {
    return this.netMcuPins[net] !== undefined;
  }

  private readonly netChanged = (net: number): void => {
    const state = this.resolver.state(net);
    this.conflict[net] = state.conflict ? 1 : 0;
    if (this.quiet) return; // a carried build settles first; syncAll then tells everyone once
    const pins = this.netMcuPins[net];
    if (pins !== undefined) for (let i = 0; i < pins.length; i++) pins[i].setInput(state);
    const listeners = this.netListeners[net];
    if (listeners !== undefined) for (let i = 0; i < listeners.length; i++) listeners[i](state);
    const probe = this.netProbe[net];
    if (probe >= 0) {
      const slot = this.probes[probe] as ProbeSlot;
      const code = levelCode(state);
      if (code !== slot.last) {
        slot.last = code;
        slot.ring.push(this.now(), code);
      }
    }
    const watcher = this.netWatcher;
    if (watcher !== null) watcher(net, state);
  };

  private flushSerial(): void {
    for (const slot of this.mcus) {
      if (slot.serialLen === 0) continue;
      const bytes = slot.serial.slice(0, slot.serialLen);
      slot.serialLen = 0;
      for (const listener of slot.serialListeners) listener(bytes);
    }
  }

  private invalidate(slot: PartSlot): void {
    if (slot.dirty) return;
    slot.dirty = true;
    this.dirtyParts.push(slot);
  }

  /** BT39: a byte `port` of `from` transmitted, to every UART whose RX is on its TX net or one resistor away. */
  private forwardUart(from: McuSlot, port: UartPort, byte: number): void {
    const tx = port.pins?.().tx;
    const net = tx === undefined ? undefined : from.netOfPin.get(tx);
    if (net === undefined) return;
    const near = this.resistorNeighbors.get(net);
    for (const to of this.mcus) {
      for (let j = 0; j < MAX_UARTS; j++) {
        const rxPort = to.mcu.uart(j);
        const rx = rxPort?.pins?.().rx;
        const rxNet = rx === undefined ? undefined : to.netOfPin.get(rx);
        if (rxPort === undefined || rxNet === undefined || (rxNet !== net && near?.includes(rxNet) !== true)) continue;
        const a = port.baud?.();
        const b = rxPort.baud?.();
        if (a !== undefined && b !== undefined && Math.abs(a - b) > 0.03 * Math.max(a, b)) {
          this.report(
            problem('warning', 'uart-baud-mismatch', `${from.partId} sends at ${Math.round(a)} baud but ${to.partId} receives at ${Math.round(b)}: real UARTs would read garbage.`, [from.partId, to.partId]),
          );
        }
        const index = j;
        this.scheduler.schedule(this.now(), () => {
          rxPort.receive(Uint8Array.of(byte));
          this.logUart(to, index, BUS.UART_RX, byte);
        });
      }
    }
  }

  /** Records a problem; one with an empty message withdraws that code for those parts. */
  private report(p: Problem): void {
    const parts = [...p.parts].sort();
    const key = `${p.code}|${parts.join(',')}`;
    if (p.message === '') {
      this.reported.delete(key);
      return;
    }
    if (!this.reported.has(key) && this.reported.size >= MAX_REPORTED) return;
    this.reported.delete(key); // newest message wins and moves to the end
    this.reported.set(key, { severity: p.severity, code: p.code, message: p.message, parts });
  }

  /** Every MCU pin and part listener sees the current state of its net once. */
  private syncAll(): void {
    for (let net = 0; net < this.netlist.netCount; net++) this.netChanged(net);
  }

  private syncMcu(slot: McuSlot): void {
    for (const entry of slot.pinEntries) entry.apply();
    for (const entry of slot.pinEntries) for (const net of entry.nets) entry.pin.setInput(this.resolver.state(net));
  }

  private mcuSlot(boardPartId: string): McuSlot {
    const slot = this.mcuByPart.get(boardPartId);
    if (slot === undefined) throw new Error(`no MCU board "${boardPartId}" on the bench`);
    return slot;
  }
}

function problem(severity: Problem['severity'], code: string, message: string, parts: string[]): Problem {
  return { severity, code, message, parts };
}

function partsOf(pins: readonly { part: string }[]): string[] {
  return [...new Set(pins.map((p) => p.part))];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
