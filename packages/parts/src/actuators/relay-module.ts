/**
 * BT193: a 1-channel 5 V relay module (`relay-module`): the common blue SRD-05VDC-SL-C board with
 * its input header (VCC, GND, IN) and screw terminals (NO, COM, NC). Its driver energizes the coil
 * while IN is active — low by default (`trigger: 'low'`, IN pulled up to VCC on the board, so a
 * floating IN is off), or high (`trigger: 'high'`, the jumper on the other side) — and VCC is at
 * 4 V or more over GND. The contacts are switch links: COM–NC closed at rest, COM–NO closed while
 * energized, each change after the relay's operate time (10 ms) or release time (5 ms), the
 * SRD-05VDC's maxima (when IN changes inside an MCU's run, up to the bench's quantum later — a timer
 * set from a pin listener fires at that run's end). Its coil current (≈ 71 mA at 5 V) isn't drawn from VCC. Visual: `powered`
 * (the power LED), `on` (the input LED: the driver is on) and `closed` (the contacts are on NO).
 */

import { NS_PER_MS, type PartProps, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';

export const RELAY_OPERATE_NS = 10 * NS_PER_MS;
export const RELAY_RELEASE_NS = 5 * NS_PER_MS;

export const relayModule = definePart({
  type: 'relay-module',
  title: 'Relay module (1 channel, 5 V)',
  category: 'output',
  size: { w: 50.8, h: 25.4 },
  pins: [
    { name: 'VCC', x: 1.27, y: 10.16, role: 'power' },
    { name: 'GND', x: 1.27, y: 12.7, role: 'ground' },
    { name: 'IN', x: 1.27, y: 15.24, role: 'digital' },
    { name: 'NO', x: 48.26, y: 7.62, role: 'passive' },
    { name: 'COM', x: 48.26, y: 12.7, role: 'passive' },
    { name: 'NC', x: 48.26, y: 17.78, role: 'passive' },
  ],
  links: [
    { id: 'no', a: 'COM', b: 'NO', kind: 'switch', closed: false },
    { id: 'nc', a: 'COM', b: 'NC', kind: 'switch', closed: true },
  ],
  defaults: { trigger: 'low' },
  createModel(ctx, props) {
    const p = props as PartProps;
    const activeHigh = p.trigger === 'high';
    const vcc = ctx.pin('VCC');
    const gnd = ctx.pin('GND');
    const input = ctx.pin('IN');
    const no = ctx.link('no');
    const nc = ctx.link('nc');
    let timer = -1;
    let want = false;
    /** The board's pull-up on IN (low trigger): told once per power change. */
    let pulled = false;
    const visual = { powered: false, on: false, closed: false };

    const settle = (): void => {
      timer = -1;
      visual.closed = want;
      no.setClosed(want);
      nc.setClosed(!want);
      ctx.invalidate();
    };
    const update = (): void => {
      const v = vcc.read();
      const g = gnd.read();
      const powered = v.level === 1 && g.level === 0 && v.volts - g.volts >= 4;
      const pull = powered && !activeHigh;
      if (pull !== pulled) {
        pulled = pull;
        if (pull) input.driveVolts(v.volts, Strength.weak);
        else input.release();
      }
      const s = input.read();
      const active = activeHigh ? s.level === 1 : s.level === 0;
      const on = powered && active;
      if (powered !== visual.powered || on !== visual.on) {
        visual.powered = powered;
        visual.on = on;
        ctx.invalidate();
      }
      if (on === want) return;
      want = on;
      if (timer >= 0) ctx.cancel(timer);
      timer = ctx.schedule(on ? RELAY_OPERATE_NS : RELAY_RELEASE_NS, settle);
    };
    vcc.onChange(update);
    gnd.onChange(update);
    input.onChange(update);
    update();

    return {
      reset() {
        timer = -1;
        want = false;
        pulled = false;
        visual.closed = false;
        no.setClosed(false);
        nc.setClosed(true);
        update();
      },
      visual: () => visual,
    };
  },
});
