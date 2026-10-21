/**
 * Photoresistor module (LM393 comparator; VCC/GND/DO/AO). Decided topology: 10 kΩ VCC→AO and
 * the LDR AO→GND as resistive links (the analog layer solves AO, load included), so brighter
 * light reads lower. LDR R = rl10·(lux/10)^(−gamma), capped at 1 MΩ. DO is a strong 0 while AO
 * reads below `threshold` volts (the module's pot), else a weak 1 (its pull-up). Input
 * { kind: 'value', value: lux }. Visual: lux and the DO LED. Pins from @wokwi/elements 1.9.2
 * photoresistor-sensor-element.
 */

import { Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { Divider } from '../shared/divider.ts';
import { ldrOhms, MODULE_DIVIDER_OHMS } from '../shared/transfer.ts';

export const photoresistorSensor = definePart({
  type: 'photoresistor-sensor',
  title: 'Photoresistor (LDR) module',
  category: 'sensors',
  size: { w: 45.95, h: 16.267 },
  pins: [
    { name: 'VCC', x: 45.508, y: 4.233, role: 'power' },
    { name: 'GND', x: 45.508, y: 6.879, role: 'ground' },
    { name: 'DO', x: 45.508, y: 9.472, role: 'digital' },
    { name: 'AO', x: 45.508, y: 12.039, role: 'analog' },
  ],
  links: [
    { id: 'pullup', a: 'VCC', b: 'AO', kind: 'resistive', ohms: MODULE_DIVIDER_OHMS },
    { id: 'ldr', a: 'AO', b: 'GND', kind: 'resistive', ohms: MODULE_DIVIDER_OHMS },
  ],
  defaults: { lux: 500, rl10: 20_000, gamma: 0.7, threshold: 2.5 },
  createModel(ctx, props) {
    const out = ctx.pin('DO');
    const aoPin = ctx.pin('AO');
    const divider = new Divider(ctx, 'pullup', 'ldr');
    let lux = Math.max(0, props.lux);
    let dark = false;
    // The comparator: DO follows AO against the threshold.
    const compare = (): void => {
      const below = aoPin.read().volts < props.threshold;
      if (below) out.drive(0, Strength.strong);
      else out.drive(1, Strength.weak);
      if (below !== dark) {
        dark = below;
        ctx.invalidate();
      }
    };
    aoPin.onChange(compare);
    const apply = (): void => {
      divider.set(MODULE_DIVIDER_OHMS, ldrOhms(lux, props.rl10, props.gamma));
      compare();
    };
    apply();
    return {
      input(event) {
        if (event.kind !== 'value') return;
        lux = Math.max(0, event.value);
        apply();
        ctx.invalidate();
      },
      // The module's DO LED lights while DO is low (light above the threshold).
      visual: () => ({ lux, ledDO: dark }),
      reset() {
        lux = Math.max(0, props.lux);
        apply();
        ctx.invalidate();
      },
    };
  },
});
