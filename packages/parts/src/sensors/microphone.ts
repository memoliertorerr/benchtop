/**
 * Microphone module (BT41), a MAX4466-style electret amplifier: OUT, GND, VCC. OUT = the supply's
 * midpoint + `gain` (volts per full-scale sample, prop, default 1) · sample, clamped to the
 * rails, driven as a strong source that follows the module's own supply (shared/supply.ts);
 * silent, it sits at VCC/2 as the real module's output does.
 *
 * Samples (−1…1) arrive as `{ kind: 'value', value }` inputs, one per sample, in order — the UI
 * sends what its microphone captured at 16 kHz (apps/web/src/ui/audio/mic.ts), a test sends a
 * synthetic tone — and play out at 16 kHz of simulated time from a queue. Simulated and wall
 * time drift apart, so the queue keeps at most 200 ms: older samples are dropped (`dropped`), and
 * an empty queue holds silence (`starved`). The output timer runs only while samples flow: it
 * starts with the first sample and stops after 100 ms with none, so an idle microphone costs
 * nothing. Visual: `level` (RMS, 0…1), `listening`, `dropped`, `starved`. Nothing is stored.
 */

import type { PartInput } from '@benchtop/core';
import { definePart } from '../define.ts';
import { supplyOutput } from '../shared/supply.ts';

export const MIC_RATE = 16_000;
const PERIOD_NS = 1e9 / MIC_RATE;
/** Most queued input, samples (200 ms). */
const MAX_QUEUE = MIC_RATE / 5;
/** Ticks with an empty queue before the output timer stops (100 ms). */
const IDLE_TICKS = MIC_RATE / 10;
/** Ticks between visual updates (50 ms). */
const VISUAL_TICKS = MIC_RATE / 20;

type MicProps = { gain: number };

export const microphone = definePart({
  type: 'microphone',
  title: 'Microphone',
  category: 'sensors',
  size: { w: 15.24, h: 19.05 },
  pins: [
    { name: 'OUT', x: 5.08, y: 17.78, role: 'analog' },
    { name: 'GND', x: 7.62, y: 17.78, role: 'ground' },
    { name: 'VCC', x: 10.16, y: 17.78, role: 'power' },
  ],
  defaults: { gain: 1 },
  createModel(ctx, props: MicProps) {
    const queue = new Float32Array(MIC_RATE);
    let qHead = 0;
    let qLen = 0;
    let current = 0;
    let running = false;
    let idle = 0;
    let ticks = 0;
    let power = 0;
    let dropped = 0;
    let starved = 0;
    const gain = Number.isFinite(props.gain) ? props.gain : 1;
    const visual = { level: 0, listening: false, dropped: 0, starved: 0 };
    const apply = supplyOutput(ctx, 'VCC', 'GND', 'OUT', (low, high) => {
      const v = (low + high) / 2 + gain * current;
      return v < low ? low : v > high ? high : v;
    });

    const tick = (): void => {
      if (qLen > 0) {
        current = queue[qHead];
        qHead = (qHead + 1) % queue.length;
        qLen--;
        idle = 0;
      } else {
        current = 0;
        starved++;
        idle++;
      }
      apply();
      power += (current * current - power) / 256;
      if (++ticks % VISUAL_TICKS === 0) ctx.invalidate();
      if (idle >= IDLE_TICKS) {
        running = false;
        current = 0;
        apply();
        ctx.invalidate();
        return;
      }
      ctx.schedule(PERIOD_NS, tick);
    };

    return {
      input(event: PartInput) {
        if (event.kind !== 'value' || !Number.isFinite(event.value)) return;
        const s = event.value < -1 ? -1 : event.value > 1 ? 1 : event.value;
        if (qLen >= MAX_QUEUE) {
          qHead = (qHead + 1) % queue.length;
          qLen--;
          dropped++;
        }
        queue[(qHead + qLen) % queue.length] = s;
        qLen++;
        if (!running) {
          running = true;
          idle = 0;
          ctx.schedule(PERIOD_NS, tick);
        }
      },
      visual() {
        visual.level = Math.min(1, Math.sqrt(power) * Math.SQRT2);
        visual.listening = running;
        visual.dropped = dropped;
        visual.starved = starved;
        return visual;
      },
      reset() {
        qHead = qLen = 0;
        current = 0;
        running = false;
        power = 0;
        dropped = starved = ticks = idle = 0;
        apply();
        ctx.invalidate();
      },
    };
  },
});
