/**
 * Piezo buzzer, prop `type` 'passive' (default) or 'active'. Passive: frequency from the period
 * between rising edges of its drive (pin 1 at 1 against pin 2 at 0), duty from the high time; it
 * falls silent after no edge for max(3 periods, 20 ms), checked by one watchdog timer (every 10 ms,
 * and exactly at that deadline) that runs only while sounding — a DC level makes no tone. Active: sounds at prop `frequency`
 * (2300 Hz) while driven. Visual: `frequency` (0 = silent), `duty`, `sounding`. Pins from
 * @wokwi/elements 1.9.2 buzzer-element.
 */

import { NS_PER_MS, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';

const WATCHDOG_NS = 10 * NS_PER_MS;
const MIN_SILENCE_NS = 20 * NS_PER_MS;

export const buzzer = definePart({
  type: 'buzzer',
  title: 'Buzzer',
  category: 'output',
  size: { w: 17, h: 20 },
  pins: [
    { name: '1', x: 7.144, y: 22.225, role: 'passive' },
    { name: '2', x: 9.79, y: 22.225, role: 'passive' },
  ],
  defaults: { type: 'passive', frequency: 2300 },
  createModel(ctx, props) {
    const plus = ctx.pin('1');
    const minus = ctx.pin('2');
    const active = props.type === 'active';
    let driven = false;
    let lastRise = Number.NEGATIVE_INFINITY;
    let lastEdge = Number.NEGATIVE_INFINITY;
    let period = 0;
    let frequency = 0;
    let duty = 0;
    let watching = false;
    const visual = { frequency: 0, duty: 0, sounding: false };
    const report = (hz: number, d: number): void => {
      if (hz === frequency && Math.abs(d - duty) < 0.005) return;
      frequency = hz;
      duty = d;
      ctx.invalidate();
    };
    // Ticks every 10 ms at most, and exactly at the silence deadline when that comes sooner.
    const watchdog = (): void => {
      const deadline = lastEdge + Math.max(3 * period, MIN_SILENCE_NS);
      const now = ctx.now();
      if (now >= deadline) {
        watching = false;
        report(0, 0);
        return;
      }
      ctx.schedule(Math.min(WATCHDOG_NS, deadline - now), watchdog);
    };
    const update = (): void => {
      const p = plus.read();
      const next = p.level === 1 && p.strength >= Strength.weak && minus.read().level === 0;
      if (next === driven) return;
      driven = next;
      const now = ctx.now();
      if (active) {
        report(next ? props.frequency : 0, next ? 0.5 : 0);
        return;
      }
      if (next) {
        const last = now - lastRise;
        if (last < 1000 * NS_PER_MS) {
          period = last;
          report(Math.round(1e10 / period) / 10, duty);
        }
        lastRise = now;
      } else if (period > 0) {
        report(frequency, Math.min(1, (now - lastRise) / period));
      }
      lastEdge = now;
      if (!watching) {
        watching = true;
        ctx.schedule(WATCHDOG_NS, watchdog);
      }
    };
    plus.onChange(update);
    minus.onChange(update);
    return {
      visual() {
        visual.frequency = frequency;
        visual.duty = Math.round(duty * 1000) / 1000;
        visual.sounding = frequency > 0;
        return visual;
      },
      reset() {
        driven = false;
        lastRise = Number.NEGATIVE_INFINITY;
        lastEdge = Number.NEGATIVE_INFINITY;
        period = 0;
        watching = false;
        report(0, 0);
      },
    };
  },
});
