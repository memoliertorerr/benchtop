/**
 * KS2E-M-DC5 relay (5 V coil, two changeover poles). Coil voltage = |V(COIL1) − V(COIL2)| from
 * the nets' volts: it energizes at ≥ 3.75 V (75 % must-operate) and releases at ≤ 0.5 V, with
 * hysteresis between. The contacts move `operateMs` (4) after the coil changes, through one
 * scheduled callback. Each pole Pn (common) is a switch link to NCn (closed at rest) and to NOn.
 * Visual: `energized` (coil), `contactsNO` (contacts). Pins from @wokwi/elements 1.9.2
 * ks2e-m-dc5-element.
 */

import { NS_PER_MS } from '@benchtop/core';
import { definePart } from '../define.ts';

const OPERATE_V = 3.75;
const RELEASE_V = 0.5;

export const relayKs2e = definePart({
  type: 'relay-ks2e-m-dc5',
  title: 'Relay (KS2E-M-DC5)',
  category: 'output',
  size: { w: 21, h: 10 },
  pins: [
    { name: 'NO2', x: 1.455, y: 1.349, role: 'passive' },
    { name: 'NC2', x: 6.615, y: 1.349, role: 'passive' },
    { name: 'P2', x: 11.906, y: 1.349, role: 'passive' },
    { name: 'COIL2', x: 19.579, y: 1.349, role: 'passive' },
    { name: 'NO1', x: 1.455, y: 8.652, role: 'passive' },
    { name: 'NC1', x: 6.615, y: 8.652, role: 'passive' },
    { name: 'P1', x: 11.906, y: 8.652, role: 'passive' },
    { name: 'COIL1', x: 19.579, y: 8.652, role: 'passive' },
  ],
  links: [
    { id: 'nc1', a: 'P1', b: 'NC1', kind: 'switch', closed: true },
    { id: 'no1', a: 'P1', b: 'NO1', kind: 'switch', closed: false },
    { id: 'nc2', a: 'P2', b: 'NC2', kind: 'switch', closed: true },
    { id: 'no2', a: 'P2', b: 'NO2', kind: 'switch', closed: false },
  ],
  defaults: { operateMs: 4 },
  createModel(ctx, props) {
    const coil1 = ctx.pin('COIL1');
    const coil2 = ctx.pin('COIL2');
    const links = [ctx.link('nc1'), ctx.link('no1'), ctx.link('nc2'), ctx.link('no2')];
    const delay = Math.max(0, props.operateMs) * NS_PER_MS;
    let energized = false;
    let contactsNO = false;
    let timer = -1;
    const visual = { energized: false, contactsNO: false };
    const move = (): void => {
      timer = -1;
      if (contactsNO === energized) return;
      contactsNO = energized;
      links[0].setClosed(!contactsNO);
      links[1].setClosed(contactsNO);
      links[2].setClosed(!contactsNO);
      links[3].setClosed(contactsNO);
      ctx.invalidate();
    };
    const update = (): void => {
      const volts = Math.abs(coil1.read().volts - coil2.read().volts);
      const next = energized ? volts > RELEASE_V : volts >= OPERATE_V;
      if (next === energized) return;
      energized = next;
      if (timer >= 0) ctx.cancel(timer);
      timer = ctx.schedule(delay, move);
      ctx.invalidate();
    };
    coil1.onChange(update);
    coil2.onChange(update);
    return {
      visual() {
        visual.energized = energized;
        visual.contactsNO = contactsNO;
        return visual;
      },
      reset() {
        energized = false;
        contactsNO = true;
        timer = -1;
        move();
        update();
      },
    };
  },
});
