/**
 * A four-stage watchdog (BT33): the TIMG main watchdogs (MWDT, TRM v5.8 "Watchdog Timers") and
 * the RTC watchdog share it. While enabled, stage n lasts `hold(n)` watchdog ticks; when it times
 * out its action runs (0 off, 1 interrupt, 2 reset CPU, 3 reset system, 4 reset RTC — the RTC
 * WDT only) and stage n + 1 starts, wrapping from stage 3 to 0. A feed, or enabling the watchdog,
 * restarts stage 0. The owner decodes its registers through WdtConfig and calls `update()` after
 * any configuration write or clock change.
 *
 * The stage end is a timed event at stageStart + hold · tickCycles; a clock change while a stage
 * runs re-times the rest of it at the new tick (the elapsed part isn't rescaled).
 */

import type { SocContext } from './context.ts';

export interface WdtConfig {
  enabled(): boolean;
  /** Stage `n`'s action. */
  action(n: number): number;
  /** Stage `n`'s length in watchdog ticks. */
  hold(n: number): number;
  /** Reference cycles per watchdog tick. */
  tickCycles(): number;
}

export class Watchdog {
  /** The running stage, or −1 while disabled. */
  stage = -1;
  private stageStart = 0;
  private readonly slot: number;
  private readonly context: SocContext;
  private readonly config: WdtConfig;
  private readonly fire: (action: number, stage: number) => void;

  constructor(context: SocContext, config: WdtConfig, fire: (action: number, stage: number) => void) {
    this.context = context;
    this.config = config;
    this.fire = fire;
    this.slot = context.events.add(() => this.timeout());
  }

  /** WDTFEED: back to the start of stage 0. */
  feed(): void {
    if (this.stage < 0) return;
    this.stage = 0;
    this.stageStart = this.context.now();
    this.schedule();
  }

  /** The configuration (or the clock) changed. */
  update(): void {
    if (!this.config.enabled()) {
      this.stop();
      return;
    }
    if (this.stage < 0) {
      this.stage = 0;
      this.stageStart = this.context.now();
    }
    this.schedule();
  }

  stop(): void {
    this.stage = -1;
    this.context.events.cancel(this.slot);
  }

  private stageEnd(): number {
    return this.stageStart + Math.max(1, this.config.hold(this.stage)) * this.config.tickCycles();
  }

  private schedule(): void {
    this.context.events.schedule(this.slot, this.stageEnd());
  }

  private timeout(): void {
    const stage = this.stage;
    if (stage < 0) return;
    const action = this.config.action(stage);
    this.stageStart = this.stageEnd();
    this.stage = (stage + 1) & 3;
    this.schedule();
    if (action !== 0) this.fire(action, stage);
  }
}
