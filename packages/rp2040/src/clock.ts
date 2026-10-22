/**
 * The RP2040's time base (BT60): rp2040js's `IClock` (nanoseconds plus alarms its timer, ADC,
 * PWM and UART peripherals schedule), owned by the adapter so the run loop decides when time
 * moves: `advance` after an instruction (or `endBatch` after many), `tickTo` while the core
 * sleeps — when no alarm is due, one compare and one store. Alarms fire in time order, each with
 * `nanos` set to its own time.
 *
 * BT76: instruction time is anchored — `anchor + count × npc`, `count` the cycles run since the
 * anchor — not a running sum, so a batch (many instructions in one call) and one instruction at
 * a time reach exactly the same times. Sleeping, PIO idling and a clock-rate change move the
 * anchor. While a batch runs (`beginBatch`), `nanos` follows the core's retired cycles — the
 * start of the instruction executing — so a peripheral reading the time or scheduling an alarm
 * sees what a tick per instruction would have given it; an alarm scheduled before the batch's
 * limit calls `onEarlier`, which ends the batch after that instruction.
 */

/** rp2040js's alarm and clock interfaces (structural: its package exports only its index). */
interface IAlarm {
  schedule(deltaNanos: number): void;
  cancel(): void;
}

interface IClock {
  readonly nanos: number;
  createAlarm(callback: () => void): IAlarm;
}

/** How far an alarm that re-fires at the same instant is pushed: one 125 MHz reference cycle. */
const RERUN_NANOS = 8;

class Alarm implements IAlarm {
  at = Infinity;
  scheduled = false;
  readonly clock: Rp2040Clock;
  readonly callback: () => void;
  constructor(clock: Rp2040Clock, callback: () => void) {
    this.clock = clock;
    this.callback = callback;
  }
  schedule(deltaNanos: number): void {
    this.at = this.clock.nanos + Math.max(0, deltaNanos);
    this.scheduled = true;
    this.clock.changed();
  }
  cancel(): void {
    if (!this.scheduled) return;
    this.scheduled = false;
    this.clock.changed();
  }
}

/** What a batch's time follows: the cycles the core's instructions took (`retired`). */
interface CycleSource {
  readonly retired: number;
}

export class Rp2040Clock implements IClock {
  private time = 0;
  /** Instruction time: `anchor + count × npc` (BT76). */
  private anchor = 0;
  private count = 0;
  private npc = 8;
  /** While a batch runs: the core whose retired cycles move time, and its count at the batch's start. */
  private batch: CycleSource | null = null;
  private batchRetired = 0;
  /** The running batch's end: an alarm scheduled before it calls onEarlier. */
  private batchLimit = Infinity;
  /** BT76: an alarm came due before the running batch's limit: end the batch. */
  onEarlier: (() => void) | null = null;

  get nanos(): number {
    const b = this.batch;
    return b === null ? this.time : this.anchor + (this.count + b.retired - this.batchRetired) * this.npc;
  }

  /** An instruction took `cycles` (a ROM call's charge included): time moves on, alarms due fire. */
  advance(cycles: number): void {
    this.count += cycles;
    this.tickTo(this.anchor + this.count * this.npc);
  }

  /** Time moved other than by instructions (the core asleep): instructions count from here. */
  anchorHere(): void {
    this.anchor = this.time;
    this.count = 0;
  }

  /** clk_sys changed to `npc` ns a cycle — inside an instruction, whose cycles count at the new rate. */
  setRate(npc: number): void {
    if (this.batch !== null) {
      this.anchor = this.nanos;
      this.batchRetired = this.batch.retired;
    } else this.anchor = this.time;
    this.count = 0;
    this.npc = npc;
  }

  /**
   * The fewest cycles (at least 1) after which instruction time reaches `limit` — found with the
   * very sums `advance` makes, so a batch stops at the instruction a tick per instruction would.
   */
  cyclesUntil(limit: number): number {
    const anchor = this.anchor;
    const count = this.count;
    const npc = this.npc;
    let c = Math.max(1, Math.ceil((limit - (anchor + count * npc)) / npc));
    while (c > 1 && anchor + (count + c - 1) * npc >= limit) c--;
    while (anchor + (count + c) * npc < limit) c++;
    return c;
  }

  /** Time follows `core`'s retired cycles until endBatch; `limit` is the batch's end. */
  beginBatch(core: CycleSource, limit: number): void {
    this.batchRetired = core.retired;
    this.batchLimit = limit;
    this.batch = core;
  }

  /** The batch's cycles become the clock's (`charged`: a ROM call's extra), then alarms due fire. */
  endBatch(charged: number): void {
    const b = this.batch;
    if (b === null) return;
    this.count += b.retired - this.batchRetired + charged;
    this.batch = null;
    this.batchLimit = Infinity;
    this.tickTo(this.anchor + this.count * this.npc);
  }

  /** The earliest scheduled alarm's time (Infinity: none). */
  nextAt = Infinity;
  /** How many alarms have fired: a change tells the run loop something may have changed. */
  fired = 0;
  private readonly alarms: Alarm[] = [];

  createAlarm(callback: () => void): IAlarm {
    const alarm = new Alarm(this, callback);
    this.alarms.push(alarm);
    return alarm;
  }

  /** Recomputes `nextAt` (an alarm was scheduled or cancelled). */
  changed(): void {
    let next = Infinity;
    for (const alarm of this.alarms) if (alarm.scheduled && alarm.at < next) next = alarm.at;
    this.nextAt = next;
    if (next < this.batchLimit) this.onEarlier?.();
  }

  /**
   * Advances to `target` nanoseconds, firing the alarms due on the way, in order. An alarm that
   * comes due again at the instant it just fired is deferred by RERUN_NANOS: rp2040js's PWM
   * compare alarms reschedule themselves with a zero delay while a slice counts with its
   * 32-bit reset TOP (firmware enabling a slice before writing TOP), which would otherwise
   * fire forever without the core running.
   */
  tickTo(target: number): void {
    let last: Alarm | undefined;
    let lastAt = -1;
    while (this.nextAt <= target) {
      let due: Alarm | undefined;
      for (const alarm of this.alarms) if (alarm.scheduled && (due === undefined || alarm.at < due.at)) due = alarm;
      if (due === undefined) break;
      if (due === last && due.at <= lastAt) {
        due.at = lastAt + RERUN_NANOS;
        this.changed();
        continue;
      }
      due.scheduled = false;
      if (due.at > this.time) this.time = due.at;
      last = due;
      lastAt = this.time;
      this.changed();
      this.fired++;
      due.callback();
    }
    if (target > this.time) this.time = target;
  }
}
