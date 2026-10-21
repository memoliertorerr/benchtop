/**
 * LED: lit while the anode net is level 1 at weak or stronger and the cathode net is level 0.
 * Visual `brightness` 0..1 comes from edge timestamps (shared/duty.ts), so PWM renders dimmed
 * and a blink flips at the exact edge. Under the analog layer it carries a real current instead
 * (shared/diode-light.ts): brightness √(Iavg / 15 mA), visual `milliamps`, and an
 * 'led-overcurrent' error above 30 mA. Pins from @wokwi/elements 1.9.2 led-element (unflipped).
 */

import { ANALOG_PROP, type PartProps, Strength } from '@benchtop/core';
import { LED_RS_OHMS, ledVf } from '../analog-specs.ts';
import { definePart } from '../define.ts';
import { DiodeLight, OvercurrentReport } from '../shared/diode-light.ts';
import { DutyChannel } from '../shared/duty.ts';

export const led = definePart({
  type: 'led',
  title: 'LED',
  category: 'output',
  size: { w: 10.583, h: 13.229 },
  pins: [
    { name: 'A', x: 6.615, y: 11.113, role: 'passive' },
    { name: 'C', x: 3.969, y: 11.113, role: 'passive' },
  ],
  defaults: { color: 'red' },
  createModel(ctx, props) {
    const anode = ctx.pin('A');
    const cathode = ctx.pin('C');
    if ((props as PartProps)[ANALOG_PROP] === true) {
      const diode = new DiodeLight(ctx, anode, cathode, ledVf(props.color), LED_RS_OHMS);
      const over = new OvercurrentReport(ctx);
      const visual = { brightness: 0, milliamps: 0 };
      const update = (): void => {
        diode.update();
        over.update(diode.amps);
      };
      anode.onChange(update);
      cathode.onChange(update);
      return {
        visual() {
          visual.brightness = diode.brightness;
          visual.milliamps = Math.round(diode.amps * 1e5) / 100;
          return visual;
        },
        reset() {
          diode.reset();
          over.reset();
          update();
          ctx.invalidate();
        },
      };
    }
    const light = new DutyChannel(ctx);
    const update = (): void => {
      const a = anode.read();
      light.set(a.level === 1 && a.strength >= Strength.weak && cathode.read().level === 0);
    };
    anode.onChange(update);
    cathode.onChange(update);
    return {
      visual: () => ({ brightness: light.brightness }),
      reset() {
        light.reset();
        ctx.invalidate();
      },
    };
  },
});
