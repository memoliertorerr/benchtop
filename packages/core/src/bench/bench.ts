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
 */

import { buildIslands } from '../analog/islands.ts';
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
import type { ProjectDoc } from '../contracts/project.ts';
import { type Level, type NetState, Strength } from '../contracts/signal.ts';
import { cyclesToNanos, nanosToCycles, NS_PER_MS, NS_PER_US, type Nanos } from '../contracts/time.ts';
import { ENV_PERIOD_NS, EnvRuntime } from '../env/runtime.ts';
import type { EnvSpecFor, PointField } from '../env/spec.ts';
import { buildNetlist, type Netlist } from '../netlist/netlist.ts';
import { type ResolverLink, SignalResolver } from '../signals/resolver.ts';
import { Scheduler } from './scheduler.ts';

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
}

interface McuPinEntry {
  readonly pin: McuPin;
  readonly drivers: number[];
  readonly nets: number[];
  readonly apply: () => void;
  /** Header pins mapped to this MCU pin, for the dynamic checks' change counts. */
  readonly watched: CheckedBoardPin[];
}

interface McuSlot {
  readonly partId: string;
  readonly mcu: Mcu;
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
}

interface SpiAttachment {
  readonly partId: string;
  readonly sck: number;
  readonly mosi: number;
  readonly miso: number;
  readonly cs: number;
  readonly device: SpiDevice;
}

export class Bench {
  readonly netlist: Netlist;
  readonly quantum: Nanos;
  private readonly resolver: SignalResolver;
  private readonly scheduler = new Scheduler();
  private time: Nanos = 0;
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

    // MCUs on board parts.
    for (const part of doc.parts) {
      const board = defOf(part.type)?.board;
      if (board === undefined) continue;
      let mcu: Mcu | undefined;
      try {
        const id = part.id;
        mcu = env.createMcu(board, id, (p) => this.report(p.parts.includes(id) ? p : { ...p, parts: [id, ...p.parts] }));
      } catch (error) {
        this.buildProblems.push(problem('error', 'mcu-unavailable', `Creating the ${board.mcu} for "${part.id}" failed: ${errorText(error)}`, [part.id]));
        continue;
      }
      if (mcu === undefined) {
        this.buildProblems.push(problem('error', 'mcu-unavailable', `No ${board.mcu} implementation for "${part.id}".`, [part.id]));
        continue;
      }
      this.addMcu(part.id, board, mcu);
    }
    this.quantum = options.quantum ?? (this.mcus.length > 1 ? 100 * NS_PER_US : NS_PER_MS);
    if (!(this.quantum > 0)) throw new RangeError(`quantum must be > 0, got ${this.quantum}`);

    // Part models. A part's logic supply is the voltage on its first consumer power pin.
    for (const part of doc.parts) {
      const def = defOf(part.type);
      if (def === undefined) continue;
      const slot: PartSlot = { id: part.id, def, model: null, logicVolts: DEFAULT_PART_VOLTS, dirty: false };
      for (const pin of def.pins) {
        if (pin.role !== 'power' || pin.volts !== undefined) continue;
        const volts = this.resolver.state(netlist.netOf(part.id, pin.name)).volts;
        if (volts > 0) slot.logicVolts = volts;
        break;
      }
      this.parts.set(part.id, slot);
      this.partList.push(slot);
      if (def.createModel === undefined) continue;
      try {
        const props = this.analogParts.has(part.id) ? { ...def.defaults, ...part.props, [ANALOG_PROP]: true } : { ...def.defaults, ...part.props };
        slot.model = def.createModel(this.makeContext(slot), props);
      } catch (error) {
        this.buildProblems.push(problem('error', 'part-model-error', `Part "${part.id}" failed to start: ${errorText(error)}`, [part.id]));
      }
    }

    this.building = false;
    for (const attachment of this.i2c) this.attachI2cDevice(attachment);
    for (const attachment of this.spi) this.attachSpiDevice(attachment);
    for (const slot of this.mcus) this.checkBusPins(slot, false); // the pins those attachments saw
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
    this.scheduler.schedule(CHECK_INTERVAL_NS, this.checkTick);

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
        env.reset();
        this.scheduler.schedule(ENV_PERIOD_NS, this.envTick);
      }
    }
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
    this.mcuSlot(boardPartId).mcu.uart(0)?.receive(bytes);
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

  /** Tears the bench down: every part model's `dispose()`. */
  dispose(): void {
    this.scheduler.clear();
    for (const slot of this.partList) slot.model?.dispose?.();
  }

  // ── Build ────────────────────────────────────────────────────────────────────────────────

  private addMcu(partId: string, board: BoardSpec, mcu: Mcu): void {
    const slot: McuSlot = {
      partId,
      mcu,
      clockHz: mcu.clockHz,
      base: 0,
      stopped: null,
      pinEntries: [],
      netOfPin: new Map(),
      serial: new Uint8Array(256),
      serialLen: 0,
      serialListeners: [],
      busPins: [],
    };
    const logicVolts = MCU_LOGIC_VOLTS[board.mcu];
    const pullOhms = MCU_PULL_OHMS[board.mcu];
    const entries = new Map<string, McuPinEntry>();
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
        const resolver = this.resolver;
        const apply = (): void => {
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
        };
        entry = { pin, drivers, nets: [], apply, watched };
        entries.set(pinId, entry);
        slot.pinEntries.push(entry);
        pin.onOutputChange(apply);
      }
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
    mcu.uart(0)?.onTransmit((byte) => {
      if (slot.serialLen === slot.serial.length) {
        const bigger = new Uint8Array(slot.serial.length * 2);
        bigger.set(slot.serial);
        slot.serial = bigger;
      }
      slot.serial[slot.serialLen++] = byte;
    });
    for (let i = 0; i < MAX_UARTS; i++) {
      const port = mcu.uart(i);
      if (port?.pins !== undefined) port.onTransmit((byte) => this.forwardUart(slot, port, byte));
    }
    this.mcus.push(slot);
    this.mcuByPart.set(partId, slot);
    for (const entry of slot.pinEntries) entry.apply();
  }

  private makeContext(slot: PartSlot): PartContext {
    const handles = new Map<string, PinHandle>();
    return {
      now: () => this.now(),
      pin: (name) => {
        let handle = handles.get(name);
        if (handle === undefined) {
          handle = this.makePinHandle(slot, name);
          handles.set(name, handle);
        }
        return handle;
      },
      link: (id) => this.makeLinkHandle(slot.id, id),
      schedule: (delay, callback) => {
        if (Number.isNaN(delay)) throw new RangeError('timer delay is NaN');
        return this.scheduler.schedule(this.now() + Math.max(0, delay), callback);
      },
      cancel: (timerId) => this.scheduler.cancel(timerId),
      invalidate: () => this.invalidate(slot),
      // A model can't know its own id, so the bench names it in every problem it reports.
      report: (p) => this.report(p.parts.includes(slot.id) ? p : { ...p, parts: [slot.id, ...p.parts] }),
      attachI2c: (sda, scl, device) => {
        const attachment = { partId: slot.id, sda: this.netOfPart(slot.id, sda), scl: this.netOfPart(slot.id, scl), device };
        this.i2c.push(attachment);
        if (!this.building) this.attachI2cDevice(attachment);
      },
      attachSpi: (pins, device) => {
        const attachment: SpiAttachment = {
          partId: slot.id,
          sck: this.netOfPart(slot.id, pins.sck),
          mosi: this.netOfPart(slot.id, pins.mosi),
          miso: this.netOfPart(slot.id, pins.miso),
          cs: this.netOfPart(slot.id, pins.cs),
          device,
        };
        this.spi.push(attachment);
        if (!this.building) this.attachSpiDevice(attachment);
      },
    };
  }

  private makePinHandle(slot: PartSlot, name: string): PinHandle {
    const net = this.netOfPart(slot.id, name);
    const resolver = this.resolver;
    let driver = -1;
    const driverId = (): number => (driver >= 0 ? driver : (driver = resolver.allocDriver(net, slot.logicVolts)));
    return {
      name,
      read: () => resolver.state(net),
      drive: (level: Level, strength: Strength = Strength.strong) => resolver.setDriver(driverId(), level, strength),
      driveVolts: (volts: number, strength: Strength = Strength.strong) => resolver.setDriverVolts(driverId(), volts, strength),
      release: () => {
        if (driver >= 0) resolver.releaseDriver(driver);
      },
      onChange: (listener) => {
        (this.netListeners[net] ??= []).push(listener);
      },
    };
  }

  private makeLinkHandle(partId: string, linkId: string): LinkHandle {
    const index = this.linkIndex.get(`${partId}\u0000${linkId}`);
    if (index === undefined) throw new Error(`part "${partId}" has no link "${linkId}"`);
    return {
      setClosed: (closed) => this.resolver.setLinkClosed(index, closed),
      // Switch-level resolution ignores resistance; the analog layer re-solves the link's island.
      setOhms: (ohms) => {
        const analog = this.analog;
        if (analog === null || !(ohms >= 0) || analog.linkOhms[index] === ohms) return;
        analog.linkOhms[index] = ohms;
        this.resolver.touchLink(index);
      },
    };
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
          controller.attach(attachment.device);
          this.i2cAttached.set(attachment, controller);
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
          controller.attach(attachment.device, () => cs.level === 0);
          this.spiAttached.set(attachment, controller);
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
    for (const [attachment, controller] of this.i2cAttached) controller.detach(attachment.device);
    for (const [attachment, controller] of this.spiAttached) controller.detach(attachment.device);
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
        this.scheduler.schedule(this.now(), () => rxPort.receive(Uint8Array.of(byte)));
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
