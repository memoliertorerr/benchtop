/**
 * Real-time pacing: how far the simulation should have advanced given the wall clock. Pure
 * logic with the wall clock injected (milliseconds, e.g. performance.now()), so the worker,
 * the tests and the headless runner pace the same way.
 *
 * The target is speed × wall time elapsed since an anchor. When the simulation falls more than
 * 100 ms of wall time behind (a paused tab, a slow host), the debt is forgiven: the anchor moves
 * so the simulation resumes at speed instead of racing to catch up. Speed Infinity means "as
 * fast as possible": the target is Infinity and the caller's own wall budget limits each run.
 */

import { NS_PER_MS, type Nanos } from '../contracts/time.ts';

/** Most wall time, in ms, the simulation may owe before the pacer forgets the debt. */
export const MAX_CATCH_UP_MS = 100;
/** The window `ratio()` averages over, in ms of wall time. */
export const RATIO_WINDOW_MS = 1000;
/** Samples closer together than this are not recorded, so the ring always spans the window. */
const SAMPLE_SPACING_MS = 10;
const RING = 256;

export class RealtimePacer {
  private speed: number;
  private wallAnchor = Number.NaN;
  private simAnchor = Number.NaN;
  private lastWall = Number.NaN;
  private readonly sampleWall = new Float64Array(RING);
  private readonly sampleSim = new Float64Array(RING);
  private sampleHead = 0;
  private sampleCount = 0;

  /** `speed`: simulated seconds per wall second; Infinity = unthrottled. */
  constructor(speed = 1) {
    this.speed = checkSpeed(speed);
  }

  /** Current speed. */
  getSpeed(): number {
    return this.speed;
  }

  /**
   * (Re)starts pacing at `wallMs`: the next `target` call anchors simulated time there. Call
   * on run and on resume after a pause. Clears the ratio history.
   */
  start(wallMs: number): void {
    this.wallAnchor = wallMs;
    this.simAnchor = Number.NaN;
    this.lastWall = wallMs;
    this.sampleCount = 0;
  }

  /** Changes speed from the most recent `target` call on; time before it keeps the old speed. */
  setSpeed(speed: number): void {
    this.speed = checkSpeed(speed);
    this.wallAnchor = this.lastWall;
    this.simAnchor = Number.NaN;
  }

  /**
   * The simulated time to run up to now, given the wall clock and where the simulation is
   * (`simNow`, ns). Never less than `simNow`. Also records a sample for `ratio()`.
   */
  target(wallMs: number, simNow: Nanos): Nanos {
    this.record(wallMs, simNow);
    if (Number.isNaN(this.simAnchor)) {
      this.simAnchor = simNow;
      if (Number.isNaN(this.wallAnchor)) this.wallAnchor = wallMs;
    }
    this.lastWall = wallMs;
    if (this.speed === Infinity) return Infinity;
    const elapsedMs = wallMs - this.wallAnchor;
    let target = this.simAnchor + this.speed * elapsedMs * NS_PER_MS;
    const maxAhead = this.speed * MAX_CATCH_UP_MS * NS_PER_MS;
    if (target - simNow > maxAhead) {
      // Forgive the debt: continue from here as if the simulation had kept up.
      target = simNow + maxAhead;
      this.simAnchor = target;
      this.wallAnchor = wallMs;
    }
    return target > simNow ? target : simNow;
  }

  /**
   * Simulated time per wall time over the last second of `target` calls (1 = real time), from
   * the `simNow` values actually reached. 0 until two samples exist.
   */
  ratio(): number {
    if (this.sampleCount < 2) return 0;
    const newest = (this.sampleHead + RING - 1) % RING;
    const wallEnd = this.sampleWall[newest];
    // The oldest sample still inside the window, or the newest one just before it.
    let from = newest;
    for (let k = 1; k < this.sampleCount; k++) {
      const i = (newest + RING - k) % RING;
      from = i;
      if (wallEnd - this.sampleWall[i] >= RATIO_WINDOW_MS) break;
    }
    const wallMs = wallEnd - this.sampleWall[from];
    if (wallMs <= 0) return 0;
    return (this.sampleSim[newest] - this.sampleSim[from]) / (wallMs * NS_PER_MS);
  }

  private record(wallMs: number, simNow: Nanos): void {
    if (this.sampleCount > 0) {
      const newest = (this.sampleHead + RING - 1) % RING;
      if (wallMs - this.sampleWall[newest] < SAMPLE_SPACING_MS) return;
    }
    this.sampleWall[this.sampleHead] = wallMs;
    this.sampleSim[this.sampleHead] = simNow;
    this.sampleHead = (this.sampleHead + 1) % RING;
    if (this.sampleCount < RING) this.sampleCount++;
  }
}

function checkSpeed(speed: number): number {
  if (!(speed > 0)) throw new RangeError(`speed must be > 0, got ${speed}`);
  return speed;
}
