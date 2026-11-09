/**
 * BT169: transistors, on the analog layer's models (BT168) by their `model` prop — datasheet
 * typicals:
 * - `npn-transistor` (TO-92, legs E-B-C): 2N2222A (β 150, Vce(sat) 0.2 V), BC547 (β 200, 0.1 V);
 * - `pnp-transistor` (TO-92, E-B-C): 2N3906 (β 150, 0.25 V), BC557 (β 200, 0.1 V);
 * - `n-mosfet` (TO-220, G-D-S): IRLZ44N (logic level: Vth 1.5 V, 0.025 Ω at 5 V), IRF540N (Vth 3 V,
 *   0.044 Ω at 10 V — barely on from a 3.3 V pin);
 * - `p-mosfet` (TO-220, G-D-S): IRF9540N (Vth −3 V, 0.117 Ω at −10 V).
 * A BJT's base–emitter junction knees at 0.65 V with 25 Ω above it. BT171: each model's continuous
 * current rating (`iMax`); the bench reports `transistor-overcurrent` above it. The drawings put the legs in
 * the order named and label them (a BC547's own legs run C-B-E: wire it by the labels). Without the
 * analog layer they connect nothing. Our own drawings (apps/web views/passives.ts); legs 2.54 mm
 * apart at the bottom edge.
 *
 * BT177: their clamps, as diodes (`analogSpecFor`): a BJT breaks down collector to emitter at its
 * Vceo (`vMax`; a PNP emitter to collector), a MOSFET has its body diode (source to drain, 0.8 V;
 * mirrored on a P-channel) and avalanches drain to source at its Vdss (`vMax`). So an inductive load
 * switched off with no flyback diode drives the switch into breakdown instead of to kilovolts, and
 * the part's model reports `transistor-avalanche` (warning) while its switch side is within 90 % of
 * the rating, held 2 s past the last kick so it can be read.
 */

import { ANALOG_PROP, NS_PER_MS, type PartContext, type PartModel, type PartProps } from '@benchtop/core';
import { definePart } from '../define.ts';

export interface BjtModel {
  beta: number;
  vceSat: number;
  rsat: number;
  /** BT171: the continuous collector current rating, amps. */
  iMax: number;
  /** BT177: its collector–emitter breakdown, Vceo, volts. */
  vMax: number;
}

export interface MosfetModel {
  vth: number;
  rdsOn: number;
  vgsOn: number;
  /** BT171: the continuous drain current rating (25 °C case), amps. */
  iMax: number;
  /** BT177: its drain–source breakdown, Vdss, volts (a magnitude). */
  vMax: number;
}

export const BJT_VBE = 0.65;
export const BJT_RB = 25;

export const BJT_MODELS: Readonly<Record<string, BjtModel>> = {
  '2N2222A': { beta: 150, vceSat: 0.2, rsat: 0.5, iMax: 0.6, vMax: 40 },
  BC547: { beta: 200, vceSat: 0.1, rsat: 1, iMax: 0.1, vMax: 45 },
  '2N3906': { beta: 150, vceSat: 0.25, rsat: 0.5, iMax: 0.2, vMax: 40 },
  BC557: { beta: 200, vceSat: 0.1, rsat: 1, iMax: 0.1, vMax: 45 },
};

/** Magnitudes; a P-channel's Vth and Vgs are negative on the part. */
export const MOSFET_MODELS: Readonly<Record<string, MosfetModel>> = {
  IRLZ44N: { vth: 1.5, rdsOn: 0.025, vgsOn: 5, iMax: 47, vMax: 55 },
  IRF540N: { vth: 3, rdsOn: 0.044, vgsOn: 10, iMax: 33, vMax: 100 },
  IRF9540N: { vth: 3, rdsOn: 0.117, vgsOn: 10, iMax: 23, vMax: 100 },
};

/** BT177: a body diode's knee and resistance; a breakdown's resistance once it conducts. */
export const BODY_DIODE = { vf: 0.8, rs: 0.05 } as const;
export const BREAKDOWN_RS = 0.5;
/** BT177: the share of its rating at which a switch side counts as kicked, and how long it's said. */
const KICK_FRACTION = 0.9;
const KICK_HOLD_NS = 2000 * NS_PER_MS;

/**
 * BT177: the model behind every transistor part — under the analog layer it watches the switch
 * side (`hi` − `lo`: collector–emitter, emitter–collector, drain–source, source–drain) against 90 %
 * of the model's breakdown and reports `transistor-avalanche` while it is there, and for 2 s after.
 */
function avalancheModel(hiPin: string, loPin: string, rating: (model: string) => number, what: string) {
  return (ctx: PartContext, props: PartProps): PartModel => {
    if (props[ANALOG_PROP] !== true) return {};
    const hi = ctx.pin(hiPin);
    const lo = ctx.pin(loPin);
    const vMax = rating(String(props.model));
    let kicked = false;
    let peak = 0;
    let timer = -1;
    const clear = (): void => {
      timer = -1;
      kicked = false;
      peak = 0;
      ctx.report({ severity: 'warning', code: 'transistor-avalanche', message: '', parts: [] });
    };
    const update = (): void => {
      const v = hi.read().volts - lo.read().volts;
      if (!(v > KICK_FRACTION * vMax)) return;
      if (v > peak) peak = v;
      if (!kicked) {
        kicked = true;
        ctx.report({
          severity: 'warning',
          code: 'transistor-avalanche',
          message: `An inductive load kicked its ${what} to about ${Math.round(peak)} V, into breakdown (${vMax} V): put a flyback diode across the load.`,
          parts: [],
        });
      }
      if (timer >= 0) ctx.cancel(timer);
      timer = ctx.schedule(KICK_HOLD_NS, clear);
    };
    hi.onChange(update);
    lo.onChange(update);
    return {
      reset() {
        if (timer >= 0) ctx.cancel(timer);
        timer = -1;
        kicked = false;
        peak = 0;
      },
    };
  };
}

const bjtRating = (fallback: string) => (model: string): number => (BJT_MODELS[model] ?? BJT_MODELS[fallback]).vMax;
const mosfetRating = (fallback: string) => (model: string): number => (MOSFET_MODELS[model] ?? MOSFET_MODELS[fallback]).vMax;

const TO92 = { w: 7.62, h: 10.2 } as const;
const TO220 = { w: 10.16, h: 21 } as const;

export const npnTransistor = definePart({
  type: 'npn-transistor',
  title: 'NPN transistor',
  category: 'basic',
  size: TO92,
  pins: [
    { name: 'E', x: 1.27, y: TO92.h, role: 'passive' },
    { name: 'B', x: 3.81, y: TO92.h, role: 'passive' },
    { name: 'C', x: 6.35, y: TO92.h, role: 'passive' },
  ],
  defaults: { model: '2N2222A' },
  createModel: avalancheModel('C', 'E', bjtRating('2N2222A'), 'collector'),
});

export const pnpTransistor = definePart({
  type: 'pnp-transistor',
  title: 'PNP transistor',
  category: 'basic',
  size: TO92,
  pins: [
    { name: 'E', x: 1.27, y: TO92.h, role: 'passive' },
    { name: 'B', x: 3.81, y: TO92.h, role: 'passive' },
    { name: 'C', x: 6.35, y: TO92.h, role: 'passive' },
  ],
  defaults: { model: '2N3906' },
  createModel: avalancheModel('E', 'C', bjtRating('2N3906'), 'collector'),
});

export const nMosfet = definePart({
  type: 'n-mosfet',
  title: 'N-channel MOSFET',
  category: 'basic',
  size: TO220,
  pins: [
    { name: 'G', x: 2.54, y: TO220.h, role: 'passive' },
    { name: 'D', x: 5.08, y: TO220.h, role: 'passive' },
    { name: 'S', x: 7.62, y: TO220.h, role: 'passive' },
  ],
  defaults: { model: 'IRLZ44N' },
  createModel: avalancheModel('D', 'S', mosfetRating('IRLZ44N'), 'drain'),
});

export const pMosfet = definePart({
  type: 'p-mosfet',
  title: 'P-channel MOSFET',
  category: 'basic',
  size: TO220,
  pins: [
    { name: 'G', x: 2.54, y: TO220.h, role: 'passive' },
    { name: 'D', x: 5.08, y: TO220.h, role: 'passive' },
    { name: 'S', x: 7.62, y: TO220.h, role: 'passive' },
  ],
  defaults: { model: 'IRF9540N' },
  createModel: avalancheModel('S', 'D', mosfetRating('IRF9540N'), 'drain'),
});
