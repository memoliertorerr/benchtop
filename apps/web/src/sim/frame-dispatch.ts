/**
 * Routes simulation frames to part views: each frame updates only the views it names, and a
 * view registered later (drawn after the frame arrived) gets that part's latest visual state at
 * once. Pure: views register an update callback, so it is tested in Node.
 */

import type { VisualState } from '@benchtop/core';
import { applyTftUpdate, hasTftUpdate, TFT_PACKED } from '@benchtop/parts';

export type ViewUpdate = (visual: VisualState) => void;

export class FrameDispatcher {
  private readonly views = new Map<string, ViewUpdate>();
  private readonly latest = new Map<string, VisualState>();
  /** BT51: each TFT's framebuffer (packed, two pixels a number), accumulated from its update stream. */
  private readonly tftFrames = new Map<string, number[]>();

  /** Registers a part's view; returns the unregister function. */
  register(part: string, update: ViewUpdate): () => void {
    this.views.set(part, update);
    const last = this.latest.get(part);
    if (last !== undefined) update(last);
    return () => {
      if (this.views.get(part) === update) this.views.delete(part);
    };
  }

  /** Applies a frame; returns how many views it updated. */
  dispatch(parts: readonly (readonly [string, VisualState])[]): number {
    let updated = 0;
    for (const [part, raw] of parts) {
      const visual = hasTftUpdate(raw) ? this.accumulate(part, raw) : raw;
      this.latest.set(part, visual);
      const update = this.views.get(part);
      if (update !== undefined) {
        update(visual);
        updated++;
      }
    }
    return updated;
  }

  /** Forgets remembered visual states (a new bench starts from its own first frame). */
  clear(): void {
    this.latest.clear();
    this.tftFrames.clear();
  }

  /**
   * A TFT's update folded into its framebuffer: the state passed on carries the whole frame as
   * `tftFrame`, so a view that registers late still paints everything.
   */
  private accumulate(part: string, visual: VisualState): VisualState {
    let frame = this.tftFrames.get(part);
    if (frame === undefined) this.tftFrames.set(part, (frame = new Array<number>(TFT_PACKED).fill(0)));
    applyTftUpdate(frame, visual);
    return { ...visual, tftFrame: frame };
  }
}
