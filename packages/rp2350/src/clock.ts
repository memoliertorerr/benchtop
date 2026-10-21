/**
 * The RP2350 SoC's time base (BT65): simulated nanoseconds and the alarms peripherals schedule
 * on them (a timer alarm, a UART character, the RISC-V timer's compare). Each alarm is one
 * preallocated object a peripheral reschedules; `tickTo` fires the ones due, in time order, each
 * with `nanos` at its own time. The run loop never lets a hart run past `nextAt`.
 */

export class Alarm {
  at = Infinity;
  scheduled = false;
  private readonly clock: SocClock;
  readonly callback: () => void;

  constructor(clock: SocClock, callback: () => void) {
    this.clock = clock;
    this.callback = callback;
  }

  /** Fires at absolute time `atNanos` (replacing any pending time). */
  scheduleAt(atNanos: number): void {
    this.at = Math.max(atNanos, this.clock.nanos);
    this.scheduled = true;
    this.clock.changed();
    this.clock.onEarlier?.(this.at);
  }

  cancel(): void {
    if (!this.scheduled) return;
    this.scheduled = false;
    this.clock.changed();
  }
}

export class SocClock {
  nanos = 0;
  /** The earliest scheduled alarm (Infinity: none). */
  nextAt = Infinity;
  /** Told each newly scheduled time (the run loop stops a hart that would run past it). */
  onEarlier: ((atNanos: number) => void) | null = null;
  private readonly alarms: Alarm[] = [];

  alarm(callback: () => void): Alarm {
    const alarm = new Alarm(this, callback);
    this.alarms.push(alarm);
    return alarm;
  }

  changed(): void {
    let next = Infinity;
    for (const alarm of this.alarms) if (alarm.scheduled && alarm.at < next) next = alarm.at;
    this.nextAt = next;
  }

  /** Advances to `target`, firing the alarms due on the way. */
  tickTo(target: number): void {
    while (this.nextAt <= target) {
      let due: Alarm | undefined;
      for (const alarm of this.alarms) if (alarm.scheduled && (due === undefined || alarm.at < due.at)) due = alarm;
      if (due === undefined) break;
      due.scheduled = false;
      if (due.at > this.nanos) this.nanos = due.at;
      this.changed();
      due.callback();
    }
    if (target > this.nanos) this.nanos = target;
  }

  /** Forgets alarms whose owner is gone (rp2040js peripherals are recreated at reset). */
  remove(alarms: readonly Alarm[]): void {
    for (const alarm of alarms) {
      alarm.scheduled = false;
      const i = this.alarms.indexOf(alarm);
      if (i >= 0) this.alarms.splice(i, 1);
    }
    this.changed();
  }

  /** Drops every alarm (reset). */
  clear(): void {
    for (const alarm of this.alarms) alarm.scheduled = false;
    this.nextAt = Infinity;
    this.nanos = 0;
  }
}
