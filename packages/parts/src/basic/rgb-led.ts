/**
 * RGB LED with a common pin: prop `common` 'cathode' (a color is lit while its pin is 1 and COM
 * is 0) or 'anode' (lit while COM is 1 and its pin is 0). Visual `ledRed`/`ledGreen`/`ledBlue`
 * brightness 0..1, the element's own property names. Pins from @wokwi/elements 1.9.2
 * rgb-led-element.
 */

import { ANALOG_PROP, type NetState, type PartProps, Strength } from '@benchtop/core';
import { LED_RS_OHMS, ledVf } from '../analog-specs.ts';
import { definePart } from '../define.ts';
import { DiodeLight, OvercurrentReport } from '../shared/diode-light.ts';
import { DutyChannel } from '../shared/duty.ts';

const on = (s: NetState): boolean => s.level === 1 && s.strength >= Strength.weak;

export const rgbLed = definePart({
  type: 'rgb-led',
  title: 'RGB LED',
  category: 'output',
  size: { w: 11.147, h: 19.204 },
  pins: [
    { name: 'R', x: 2.249, y: 11.642, role: 'passive' },
    { name: 'COM', x: 4.763, y: 14.287, role: 'passive' },
    { name: 'G', x: 6.985, y: 11.642, role: 'passive' },
    { name: 'B', x: 9.446, y: 11.642, role: 'passive' },
  ],
  defaults: { common: 'cathode' },
  createModel(ctx, props) {
    const anodeCommon = props.common === 'anode';
    const com = ctx.pin('COM');
    if ((props as PartProps)[ANALOG_PROP] === true) {
      // Under the analog layer: real currents (red, green, blue knees 1.8 / 2.0 / 2.8 V).
      const diodes = (['R', 'G', 'B'] as const).map((name, i) => {
        const pin = ctx.pin(name);
        const vf = ledVf(['red', 'green', 'blue'][i]);
        return anodeCommon ? new DiodeLight(ctx, com, pin, vf, LED_RS_OHMS) : new DiodeLight(ctx, pin, com, vf, LED_RS_OHMS);
      });
      const over = new OvercurrentReport(ctx);
      const update = (): void => {
        let max = 0;
        for (const d of diodes) {
          d.update();
          if (d.amps > max) max = d.amps;
        }
        over.update(max);
      };
      com.onChange(update);
      for (const name of ['R', 'G', 'B']) ctx.pin(name).onChange(update);
      return {
        visual: () => ({ ledRed: diodes[0].brightness, ledGreen: diodes[1].brightness, ledBlue: diodes[2].brightness }),
        reset() {
          for (const d of diodes) d.reset();
          over.reset();
          update();
          ctx.invalidate();
        },
      };
    }
    const colors = (['R', 'G', 'B'] as const).map((name) => ({ pin: ctx.pin(name), light: new DutyChannel(ctx) }));
    const update = (): void => {
      const c = com.read();
      for (const { pin, light } of colors) {
        const s = pin.read();
        light.set(anodeCommon ? on(c) && s.level === 0 : on(s) && c.level === 0);
      }
    };
    com.onChange(update);
    for (const { pin } of colors) pin.onChange(update);
    return {
      visual: () => ({ ledRed: colors[0].light.brightness, ledGreen: colors[1].light.brightness, ledBlue: colors[2].light.brightness }),
      reset() {
        for (const { light } of colors) light.reset();
        ctx.invalidate();
      },
    };
  },
});
