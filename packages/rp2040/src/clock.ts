/**
 * The RP2040's time base (BT60): rp2040js's `IClock` (nanoseconds plus alarms its timer, ADC,
 * PWM and UART peripherals schedule), owned by the adapter so the run loop decides when time
 * moves. `tickTo` is called once per instruction: when no alarm is due it is one compare and one
 * store. Alarms fire in time order, each with `nanos` set to its own time.
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

export class Rp2040Clock implements IClock {
  nanos = 0;
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
      if (due.at > this.nanos) this.nanos = due.at;
      last = due;
      lastAt = this.nanos;
      this.changed();
      this.fired++;
      due.callback();
    }
    if (target > this.nanos) this.nanos = target;
  }
}
