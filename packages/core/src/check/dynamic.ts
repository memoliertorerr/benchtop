/**
 * Dynamic circuit checks, run by the bench every 10 ms of simulated time (a bench timer, so the
 * worker, the tests and the CLI agree). Each run recomputes its problems; they disappear when
 * the cause does.
 * - floating-input (warning): an MCU pin in mode 'input' (no pull) whose net is floating and
 *   reaches at least one other part, for two consecutive checks with no mode change between
 *   them (so a keypad's scan lines, INPUT between scans, aren't flagged). Decided approximation:
 *   the Mcu contract can't say whether firmware read the pin, so wired floating inputs are
 *   flagged.
 * - esp32-overvoltage (error): an ESP32 board pin's net above 3.6 V.
 * - pin-overcurrent (error, BT47): an MCU pin driving its net (output, peripheral or a DAC) with
 *   more than its absolute maximum current, (drive − net volts) / STRONG_OHMS — only on nets the
 *   analog layer solves (a switch-level net carries nominal volts; shorts and outputs wired to a
 *   supply have their own problems). Reported while a check saw it within the last second, so a
 *   blinking or PWM pin is caught whenever it is on, and doesn't flicker in the panel.
 * - port-overcurrent (warning): an AVR pin group (`PORT_GROUPS`, from the datasheets) whose pins
 *   source, or sink, more together than the group's limit — the per-pin currents above, summed by
 *   board, group and direction, each MCU pin once per net. Held for 1 s like a pin's.
 * - unpowered-part (warning): a wired part whose power nets, or ground nets, all have no driver.
 */

import type { BoardSpec, Problem } from '../contracts/part.ts';
import type { McuPin } from '../contracts/mcu.ts';
import { type NetState, Strength } from '../contracts/signal.ts';
import type { Netlist } from '../netlist/netlist.ts';
import { STRONG_OHMS } from '../analog/layer.ts';
import { type PortGroup, PORT_GROUPS } from './port-groups.ts';
import { MAX_INPUT_VOLTS } from './static.ts';

/**
 * Absolute maximum DC current per I/O pin, amps: 40 mA on the ATmega328P and ATmega2560
 * (datasheets, "Absolute Maximum Ratings"), and 40 mA for the ESP32 at its default drive
 * strength (ESP32 datasheet, DC characteristics: I_OH up to 40 mA). The RP2040 and RP2350 give
 * no per-pin maximum; their strongest drive setting is 12 mA (pad DC characteristics), the
 * limit used here.
 */
export const MAX_PIN_AMPS: Readonly<Record<BoardSpec['mcu'], number>> = { atmega328p: 0.04, atmega2560: 0.04, esp32: 0.04, rp2040: 0.012, rp2350: 0.012 };
/** Checks (10 ms each) a pin overcurrent stays reported after the last one that saw it: 1 s. */
const OVERCURRENT_HOLD = 100;
const CHIP_NAMES: Readonly<Record<BoardSpec['mcu'], string>> = { atmega328p: 'ATmega328P', atmega2560: 'ATmega2560', esp32: 'ESP32', rp2040: 'RP2040', rp2350: 'RP2350' };
/** A pin a port-overcurrent names carries at least this much of the group's current, amps. */
const CONTRIBUTOR_AMPS = 0.001;

export interface CheckedBoardPin {
  board: string;
  header: string;
  mcu: BoardSpec['mcu'];
  pin: McuPin;
  net: number;
  /** The MCU's logic supply: what the pin drives for level 1. */
  vcc: number;
  /** Bumped by the bench whenever the pin's mode or output changes. */
  changes: number;
}

export interface CheckedPart {
  part: string;
  /** Nets of its connected power pins and ground pins. */
  powerNets: number[];
  groundNets: number[];
}

/** One port group of one board in one direction: what its pins' currents sum into. */
interface GroupSlot {
  board: string;
  mcu: BoardSpec['mcu'];
  direction: 'source' | 'sink';
  group: PortGroup;
}

export class DynamicChecks {
  private readonly boardPins: readonly CheckedBoardPin[];
  private readonly parts: readonly CheckedPart[];
  private readonly netlist: Netlist;
  private readonly state: (net: number) => NetState;
  /** Consecutive floating checks per board pin, and its change count at the last check. */
  private readonly floating: Uint8Array;
  private readonly seenChanges: Float64Array;
  /** Whether the analog layer solves a net (its volts are real, not nominal). */
  private readonly solved: (net: number) => boolean;
  /** Checks left to keep reporting a pin's overcurrent, and the current last seen above the limit. */
  private readonly overHold: Uint8Array;
  private readonly overAmps: Float64Array;
  /** Each board pin's current at the last check, amps: positive sources, negative sinks. */
  private readonly amps: Float64Array;
  /**
   * Each board pin's group slot per direction, −1 for none: no group, or a second header of an
   * MCU pin on a net its first header already counts.
   */
  private readonly sourceSlot: Int32Array;
  private readonly sinkSlot: Int32Array;
  private readonly slots: GroupSlot[] = [];
  /** Per slot: summed current at the last check, checks left to report it, and its report. */
  private readonly slotAmps: Float64Array;
  private readonly slotHold: Uint8Array;
  private readonly slotProblems: (Problem | null)[];

  constructor(
    boardPins: readonly CheckedBoardPin[],
    parts: readonly CheckedPart[],
    netlist: Netlist,
    state: (net: number) => NetState,
    solved: (net: number) => boolean = () => false,
  ) {
    this.boardPins = boardPins;
    this.parts = parts;
    this.netlist = netlist;
    this.state = state;
    this.solved = solved;
    this.floating = new Uint8Array(boardPins.length);
    this.seenChanges = new Float64Array(boardPins.length);
    this.overHold = new Uint8Array(boardPins.length);
    this.overAmps = new Float64Array(boardPins.length);
    this.amps = new Float64Array(boardPins.length);
    this.sourceSlot = new Int32Array(boardPins.length).fill(-1);
    this.sinkSlot = new Int32Array(boardPins.length).fill(-1);
    const slotOf = new Map<string, number>();
    const netsOf = new Map<McuPin, number[]>();
    boardPins.forEach((p, i) => {
      const nets = netsOf.get(p.pin) ?? [];
      netsOf.set(p.pin, nets);
      if (nets.includes(p.net)) return;
      nets.push(p.net);
      this.sourceSlot[i] = this.slotFor(p, 'source', slotOf);
      this.sinkSlot[i] = this.slotFor(p, 'sink', slotOf);
    });
    this.slotAmps = new Float64Array(this.slots.length);
    this.slotHold = new Uint8Array(this.slots.length);
    this.slotProblems = this.slots.map(() => null);
  }

  reset(): void {
    this.floating.fill(0);
    this.overHold.fill(0);
    this.slotHold.fill(0);
    this.slotProblems.fill(null);
  }

  run(): Problem[] {
    const problems: Problem[] = [];
    this.slotAmps.fill(0);
    this.boardPins.forEach((p, i) => {
      const s = this.state(p.net);
      const others = this.otherParts(p.net, p.board);
      const floating = p.pin.mode() === 'input' && s.level === null && s.strength === Strength.hiz && others.length > 0;
      const steady = p.changes === this.seenChanges[i];
      this.seenChanges[i] = p.changes;
      this.floating[i] = floating ? (steady ? Math.min(2, this.floating[i] + 1) : 1) : 0;
      if (this.floating[i] >= 2) {
        problems.push({
          severity: 'warning',
          code: 'floating-input',
          message: `${p.board}:${p.header} is an INPUT with nothing driving it (floating).`,
          parts: [p.board, ...others],
        });
      }
      if (p.mcu === 'esp32' && s.volts > MAX_INPUT_VOLTS.esp32) {
        problems.push({
          severity: 'error',
          code: 'esp32-overvoltage',
          message: `${p.board}:${p.header} is at ${s.volts.toFixed(2)} V; ESP32 pins take at most ${MAX_INPUT_VOLTS.esp32} V.`,
          parts: [p.board, ...others],
        });
      }
      const signed = this.pinCurrent(p, s);
      this.amps[i] = signed;
      if (signed > 0 && this.sourceSlot[i] >= 0) this.slotAmps[this.sourceSlot[i]] += signed;
      else if (signed < 0 && this.sinkSlot[i] >= 0) this.slotAmps[this.sinkSlot[i]] -= signed;
      const amps = Math.abs(signed);
      if (amps > MAX_PIN_AMPS[p.mcu]) {
        this.overHold[i] = OVERCURRENT_HOLD;
        this.overAmps[i] = amps;
      } else if (this.overHold[i] > 0) this.overHold[i]--;
      if (this.overHold[i] > 0) {
        const mA = Math.round(this.overAmps[i] * 1000);
        problems.push({
          severity: 'error',
          code: 'pin-overcurrent',
          message: `${p.board}:${p.header} carries about ${mA} mA; ${CHIP_NAMES[p.mcu]} pins take at most ${Math.round(MAX_PIN_AMPS[p.mcu] * 1000)} mA.`,
          parts: [p.board, ...others],
        });
      }
    });
    this.slots.forEach((slot, k) => {
      if (this.slotAmps[k] > slot.group.maxAmps) {
        this.slotHold[k] = OVERCURRENT_HOLD;
        this.slotProblems[k] = this.groupProblem(k);
      } else if (this.slotHold[k] > 0) this.slotHold[k]--;
      const problem = this.slotProblems[k];
      if (this.slotHold[k] > 0 && problem !== null) problems.push(problem);
    });
    for (const part of this.parts) {
      const dead = (nets: number[]): boolean => nets.length > 0 && nets.every((net) => this.state(net).strength === Strength.hiz);
      if (dead(part.powerNets) || dead(part.groundNets)) {
        problems.push({ severity: 'warning', code: 'unpowered-part', message: `${part.part}'s power or ground is wired but nothing drives it.`, parts: [part.part] });
      }
    }
    return problems;
  }

  /**
   * Amps a board pin drives into its net, positive when it sources and negative when it sinks:
   * 0 unless it drives and the analog layer solves the net.
   */
  private pinCurrent(p: CheckedBoardPin, s: NetState): number {
    if (s.conflict || !this.solved(p.net)) return 0;
    const dac = p.pin.outputVolts?.();
    let drive: number;
    if (dac !== undefined) drive = dac;
    else {
      const mode = p.pin.mode();
      if (mode !== 'output' && mode !== 'peripheral') return 0;
      drive = p.pin.outputLevel() === 1 ? p.vcc : 0;
    }
    return (drive - s.volts) / STRONG_OHMS;
  }

  /** The slot of the port group holding `p`'s MCU pin in `direction`, made on first use; −1 if none. */
  private slotFor(p: CheckedBoardPin, direction: GroupSlot['direction'], slotOf: Map<string, number>): number {
    const groups = PORT_GROUPS[p.mcu][direction];
    const g = groups.findIndex((group) => group.pins.includes(p.pin.id));
    if (g < 0) return -1;
    const key = `${p.board}|${direction}|${g}`;
    let slot = slotOf.get(key);
    if (slot === undefined) {
      slot = this.slots.length;
      slotOf.set(key, slot);
      this.slots.push({ board: p.board, mcu: p.mcu, direction, group: groups[g] });
    }
    return slot;
  }

  /** The port-overcurrent report for slot `k`, naming the pins carrying its current at this check. */
  private groupProblem(k: number): Problem {
    const { board, mcu, direction, group } = this.slots[k];
    const pinSlots = direction === 'source' ? this.sourceSlot : this.sinkSlot;
    const headers: string[] = [];
    const parts = new Set([board]);
    this.boardPins.forEach((p, i) => {
      const amps = direction === 'source' ? this.amps[i] : -this.amps[i];
      if (pinSlots[i] !== k || amps < CONTRIBUTOR_AMPS) return;
      headers.push(p.header);
      for (const part of this.otherParts(p.net, p.board)) parts.add(part);
    });
    headers.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })); // A0, A1, …, not pin-map order
    const mA = Math.round(this.slotAmps[k] * 1000);
    return {
      severity: 'warning',
      code: 'port-overcurrent',
      message: `${board} pins ${headers.join(', ')} ${direction} about ${mA} mA together; the ${CHIP_NAMES[mcu]}'s pin group ${group.name} may ${direction} at most ${Math.round(group.maxAmps * 1000)} mA.`,
      parts: [...parts],
    };
  }

  /** Parts other than `board` with a pin on `net`. */
  private otherParts(net: number, board: string): string[] {
    const parts = new Set<string>();
    for (const pin of this.netlist.pinsOfNet(net)) if (pin.part !== board) parts.add(pin.part);
    return [...parts];
  }
}
