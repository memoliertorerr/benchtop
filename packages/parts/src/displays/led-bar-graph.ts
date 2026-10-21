/**
 * 10-segment LED bar graph: bar i is lit while Ai is driven high and Ci is low; brightness from
 * edge timestamps (shared/duty.ts), like an LED. Prop `color`: a CSS color or the element's
 * palettes 'GYR' / 'BCYR'. Visual `values`: 10 brightnesses, bar 1 first. Pins from
 * @wokwi/elements 1.9.2 led-bar-graph-element.
 */

import { ANALOG_PROP, type PartProps, type PinDef, Strength } from '@benchtop/core';
import { barColor, LED_RS_OHMS, ledVf } from '../analog-specs.ts';
import { definePart } from '../define.ts';
import { DiodeLight, OvercurrentReport } from '../shared/diode-light.ts';
import { DutyChannel } from '../shared/duty.ts';

const BARS = 10;
const ROW_Y = [1.27, 3.81, 6.351, 8.891, 11.431, 13.972, 16.512, 19.052, 21.593, 24.133];

const pins: PinDef[] = [
  ...ROW_Y.map((y, i): PinDef => ({ name: `A${i + 1}`, x: 1.27, y, role: 'passive' })),
  ...ROW_Y.map((y, i): PinDef => ({ name: `C${i + 1}`, x: 8.831, y, role: 'passive' })),
];

export const ledBarGraph = definePart({
  type: 'led-bar-graph',
  title: 'LED bar graph',
  category: 'displays',
  size: { w: 10.1, h: 25.5 },
  pins,
  defaults: { color: 'red' },
  createModel(ctx, props) {
    const bars = Array.from({ length: BARS }, (_, i) => ({ anode: ctx.pin(`A${i + 1}`), cathode: ctx.pin(`C${i + 1}`), light: new DutyChannel(ctx) }));
    const values: number[] = new Array<number>(BARS).fill(0);
    const visual = { values };
    if ((props as PartProps)[ANALOG_PROP] === true) {
      const diodes = bars.map((bar, i) => new DiodeLight(ctx, bar.anode, bar.cathode, ledVf(barColor(props.color, i)), LED_RS_OHMS));
      const over = new OvercurrentReport(ctx);
      const update = (): void => {
        let max = 0;
        for (const d of diodes) {
          d.update();
          if (d.amps > max) max = d.amps;
        }
        over.update(max);
      };
      for (const bar of bars) {
        bar.anode.onChange(update);
        bar.cathode.onChange(update);
      }
      return {
        visual() {
          for (let i = 0; i < BARS; i++) values[i] = diodes[i].brightness;
          return visual;
        },
        reset() {
          for (const d of diodes) d.reset();
          over.reset();
          update();
          ctx.invalidate();
        },
      };
    }
    for (const bar of bars) {
      const update = (): void => {
        const a = bar.anode.read();
        bar.light.set(a.level === 1 && a.strength >= Strength.weak && bar.cathode.read().level === 0);
      };
      bar.anode.onChange(update);
      bar.cathode.onChange(update);
    }
    return {
      visual() {
        for (let i = 0; i < BARS; i++) values[i] = bars[i].light.brightness;
        return visual;
      },
      reset() {
        for (const bar of bars) bar.light.reset();
        ctx.invalidate();
      },
    };
  },
});
