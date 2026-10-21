/**
 * Speaker (BT41): two pins, `1` (+) and `2` (−); no electrical load. Its model reconstructs the
 * drive waveform — V(1) − V(2) from the nets' volts, so a digital pin's 0/5 V and a DAC's
 * volts alike — as audio sampled at 22,050 Hz of simulated time:
 *
 * - A one-pole low-pass at 8 kHz (the speaker's own filtering), solved exactly for the
 *   piecewise-constant drive between edges: y → x + (y − x)·e^(−Δ/τ).
 * - Each sample is that output averaged over its sample period (the integral, also exact), a
 *   box filter on top, so a PWM carrier (62.5 kHz on an Uno's Timer2) doesn't alias into the
 *   audio band. PWM-DAC audio survives; the carrier is gone.
 * - Samples go into a preallocated ring, in blocks of 1,024. A timer at each block's end
 *   completes it (the drive may not change for a while) and invalidates the part; `visual()`
 *   hands out every whole block since the last frame: `audio` (volts, the blocks back to back),
 *   `audioT` (ns of each block's first sample), `audioRate`. The UI plays them
 *   (apps/web/src/ui/audio/).
 * - Idle: once a whole block passed with no edge and the filter settled, sampling stops (a DC
 *   level is silence); the next edge starts a new run of blocks at its own time. So a silent
 *   speaker costs nothing, and the stream's `audioT` jumps over the gap.
 *
 * Per edge: O(1) work plus one step per sample boundary crossed; no allocation (AGENTS rule 3).
 * A full ring (more than 32 blocks between two frames, at speeds far beyond real time) drops
 * its oldest blocks; `visual().dropped` counts them.
 */

import type { Nanos } from '@benchtop/core';
import { definePart } from '../define.ts';

export const SPEAKER_RATE = 22_050;
export const SPEAKER_BLOCK = 1024;
const RING_BLOCKS = 32;
const CUTOFF_HZ = 8000;
/** ns per sample, and the filter's time constant in ns. */
const PERIOD_NS = 1e9 / SPEAKER_RATE;
const TAU_NS = 1e9 / (2 * Math.PI * CUTOFF_HZ);
/** Settled: the output within this of the input, volts. */
const SETTLED_V = 1e-4;

export const speaker = definePart({
  type: 'speaker',
  title: 'Speaker',
  category: 'output',
  size: { w: 20.32, h: 22.86 },
  pins: [
    { name: '1', x: 7.62, y: 21.59, role: 'passive' },
    { name: '2', x: 12.7, y: 21.59, role: 'passive' },
  ],
  defaults: {},
  createModel(ctx) {
    const plus = ctx.pin('1');
    const minus = ctx.pin('2');
    const ring = new Float32Array(SPEAKER_BLOCK * RING_BLOCKS);
    /** Sample index (in simulated time) of each ring block's first sample. */
    const blockStart = new Float64Array(RING_BLOCKS);
    let head = 0; // blocks written (complete), mod RING_BLOCKS for the slot
    let tail = 0; // blocks handed out
    let dropped = 0;
    let fill = 0; // samples in the block being written
    let active = false;
    /** Filter state: input x (volts), output y, time of the last update (ns). */
    let x = 0;
    let y = 0;
    let lastT: Nanos = 0;
    /** The current sample's index, the integral of y over it so far, and when it ends. */
    let sample = 0;
    let integral = 0;
    let binEnd = 0;
    let edges = 0;
    let edgesAtBlockStart = 0;
    let timer = -1;
    const visual = { playing: false, audio: [] as number[], audioT: [] as number[], audioRate: SPEAKER_RATE, dropped: 0 };

    const drive = (): number => plus.read().volts - minus.read().volts;

    /** Advances the filter to `t`, writing every sample that ends by then. */
    const advance = (t: Nanos): void => {
      while (lastT < t) {
        const end = t < binEnd ? t : binEnd;
        const dt = end - lastT;
        const e = Math.exp(-dt / TAU_NS);
        integral += x * dt + (y - x) * TAU_NS * (1 - e);
        y = x + (y - x) * e;
        lastT = end;
        if (end === binEnd) {
          if (fill === 0) blockStart[head % RING_BLOCKS] = sample;
          ring[(head % RING_BLOCKS) * SPEAKER_BLOCK + fill] = integral / PERIOD_NS;
          integral = 0;
          sample++;
          binEnd = sample * PERIOD_NS + PERIOD_NS;
          if (++fill === SPEAKER_BLOCK) {
            fill = 0;
            head++;
            if (head - tail > RING_BLOCKS) {
              tail = head - RING_BLOCKS;
              dropped++;
            }
          }
        }
      }
    };

    /** At each block's end: hand it out; stop once a block passed with no edge and nothing moving. */
    const blockEnd = (): void => {
      timer = -1;
      advance(ctx.now());
      ctx.invalidate();
      if (edges === edgesAtBlockStart && Math.abs(y - x) < SETTLED_V && fill === 0) {
        active = false;
        return;
      }
      edgesAtBlockStart = edges;
      scheduleBlockEnd();
    };
    const scheduleBlockEnd = (): void => {
      const remaining = SPEAKER_BLOCK - fill;
      const at = (sample + remaining) * PERIOD_NS;
      timer = ctx.schedule(Math.max(1, Math.ceil(at - ctx.now())), blockEnd);
    };

    const onEdge = (): void => {
      const now = ctx.now();
      const next = drive();
      if (!active) {
        if (next === x) return;
        // A new run of blocks from the first sample boundary after now; the filter keeps its state.
        active = true;
        sample = Math.ceil(now / PERIOD_NS);
        binEnd = sample * PERIOD_NS + PERIOD_NS;
        // Evolve to the first boundary without writing (the partial sample before it is dropped).
        const start = sample * PERIOD_NS;
        lastT = now;
        x = next;
        const e = Math.exp(-(start - now) / TAU_NS);
        y = x + (y - x) * e;
        lastT = start;
        integral = 0;
        fill = 0;
        edges++;
        edgesAtBlockStart = edges;
        scheduleBlockEnd();
        return;
      }
      advance(now);
      x = next;
      edges++;
    };
    plus.onChange(onEdge);
    minus.onChange(onEdge);

    return {
      visual() {
        // Per frame, not per sample: fresh arrays the frame message carries away.
        const blocks = head - tail;
        const audio = new Array<number>(blocks * SPEAKER_BLOCK);
        const starts = new Array<number>(blocks);
        for (let b = 0; b < blocks; b++) {
          const slot = (tail + b) % RING_BLOCKS;
          starts[b] = blockStart[slot] * PERIOD_NS;
          for (let i = 0; i < SPEAKER_BLOCK; i++) audio[b * SPEAKER_BLOCK + i] = ring[slot * SPEAKER_BLOCK + i];
        }
        visual.audioT = starts;
        visual.audio = audio;
        visual.playing = active;
        visual.dropped = dropped;
        tail = head;
        return visual;
      },
      reset() {
        if (timer >= 0) ctx.cancel(timer);
        timer = -1;
        head = tail = fill = dropped = edges = edgesAtBlockStart = 0;
        active = false;
        x = y = 0;
        lastT = 0;
        sample = 0;
        integral = 0;
        binEnd = 0;
        x = drive();
        y = x;
        ctx.invalidate();
      },
      dispose() {
        if (timer >= 0) ctx.cancel(timer);
      },
    };
  },
});
