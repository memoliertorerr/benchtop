/**
 * Flame and gas (MQ-2) sensor modules (BT53): an analog output from the sensor through the
 * module's transfer curve (shared/transfer.ts: `flameVolts`, `mq2Volts`), and DOUT from the
 * on-board LM393 comparator against the trimmer — active low on both modules, a strong 0 while
 * triggered, else a strong 1 — with the signal LED lit while triggered. The threshold prop is a
 * fraction of VCC (the trimmer's setting). Unpowered, the outputs are released. Inputs:
 * `{ kind: 'value', value }` — flame intensity 0..1, gas concentration in ppm. Pins from
 * @wokwi/elements 1.9.2 flame-sensor-element and gas-sensor-element.
 *
 * - flame-sensor: AO falls with infrared (no flame ≈ VCC); triggered while AO < threshold·VCC.
 * - gas-sensor: AO rises with gas (clean air ≈ 0.46 V at 5 V); triggered while AO > threshold·VCC.
 *   No heater warm-up (decided: usability).
 */

import { type PartContext, type PartInput, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { flameVolts, mq2Volts } from '../shared/transfer.ts';

const PX = 25.4 / 96;
const mm = (px: number): number => Math.round(px * PX * 1000) / 1000;

function moduleModel(ctx: PartContext, initial: number, threshold: number, volts: (low: number, high: number, v: number) => number, triggered: (ao: number, vcc: number) => boolean, ledKey: string) {
  const vcc = ctx.pin('VCC');
  const gnd = ctx.pin('GND');
  const aout = ctx.pin('AOUT');
  const dout = ctx.pin('DOUT');
  let value = initial;
  let on = false;
  let signal = false;
  const update = (): void => {
    const h = vcc.read();
    const l = gnd.read();
    on = h.strength !== Strength.hiz && l.strength !== Strength.hiz && h.volts > l.volts;
    if (!on) {
      aout.release();
      dout.release();
      signal = false;
    } else {
      const ao = volts(l.volts, h.volts, value);
      aout.driveVolts(ao, Strength.strong);
      signal = triggered(ao - l.volts, (h.volts - l.volts) * threshold);
      dout.drive(signal ? 0 : 1, Strength.strong);
    }
    ctx.invalidate();
  };
  vcc.onChange(update);
  gnd.onChange(update);
  update();
  return {
    input(event: PartInput) {
      if (event.kind === 'value' && Number.isFinite(event.value)) {
        value = event.value;
        update();
      }
    },
    visual: () => ({ ledPower: on, [ledKey]: signal, value }),
    reset() {
      value = initial;
      update();
    },
  };
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export const FLAME_PIN_PX = [
  ['VCC', 199, 14.6],
  ['GND', 199, 24.3],
  ['DOUT', 199, 34],
  ['AOUT', 199, 43.7],
] as const;

export const GAS_PIN_PX = [
  ['AOUT', 137, 16.5],
  ['DOUT', 137, 26.4],
  ['GND', 137, 36.5],
  ['VCC', 137, 46.2],
] as const;

const role = (name: string) => (name === 'VCC' ? ('power' as const) : name === 'GND' ? ('ground' as const) : name === 'AOUT' ? ('analog' as const) : ('digital' as const));

export const flameSensor = definePart({
  type: 'flame-sensor',
  title: 'Flame sensor module',
  category: 'sensors',
  size: { w: 52.904, h: 16.267 },
  pins: FLAME_PIN_PX.map(([name, x, y]) => ({ name, x: mm(x), y: mm(y), role: role(name) })),
  defaults: { intensity: 0, threshold: 0.5 },
  createModel: (ctx, props) =>
    moduleModel(ctx, Math.min(1, Math.max(0, num(props.intensity, 0))), num(props.threshold, 0.5), flameVolts, (ao, limit) => ao < limit, 'ledSignal'),
});

export const gasSensor = definePart({
  type: 'gas-sensor',
  title: 'Gas sensor (MQ-2) module',
  category: 'sensors',
  size: { w: 36.232, h: 16.617 },
  pins: GAS_PIN_PX.map(([name, x, y]) => ({ name, x: mm(x), y: mm(y), role: role(name) })),
  defaults: { ppm: 0, threshold: 0.5 },
  createModel: (ctx, props) => moduleModel(ctx, Math.max(0, num(props.ppm, 0)), num(props.threshold, 0.5), mq2Volts, (ao, limit) => ao > limit, 'ledD0'),
});
