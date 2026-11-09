/**
 * BT169: transistors, on the analog layer's models (BT168) by their `model` prop — datasheet
 * typicals:
 * - `npn-transistor` (TO-92, legs E-B-C): 2N2222A (β 150, Vce(sat) 0.2 V), BC547 (β 200, 0.1 V);
 * - `pnp-transistor` (TO-92, E-B-C): 2N3906 (β 150, 0.25 V), BC557 (β 200, 0.1 V);
 * - `n-mosfet` (TO-220, G-D-S): IRLZ44N (logic level: Vth 1.5 V, 0.025 Ω at 5 V), IRF540N (Vth 3 V,
 *   0.044 Ω at 10 V — barely on from a 3.3 V pin);
 * - `p-mosfet` (TO-220, G-D-S): IRF9540N (Vth −3 V, 0.117 Ω at −10 V).
 * A BJT's base–emitter junction knees at 0.65 V with 25 Ω above it. The drawings put the legs in
 * the order named and label them (a BC547's own legs run C-B-E: wire it by the labels). Without the
 * analog layer they connect nothing. Our own drawings (apps/web views/passives.ts); legs 2.54 mm
 * apart at the bottom edge.
 */

import { definePart } from '../define.ts';

export interface BjtModel {
  beta: number;
  vceSat: number;
  rsat: number;
}

export interface MosfetModel {
  vth: number;
  rdsOn: number;
  vgsOn: number;
}

export const BJT_VBE = 0.65;
export const BJT_RB = 25;

export const BJT_MODELS: Readonly<Record<string, BjtModel>> = {
  '2N2222A': { beta: 150, vceSat: 0.2, rsat: 0.5 },
  BC547: { beta: 200, vceSat: 0.1, rsat: 1 },
  '2N3906': { beta: 150, vceSat: 0.25, rsat: 0.5 },
  BC557: { beta: 200, vceSat: 0.1, rsat: 1 },
};

/** Magnitudes; a P-channel's Vth and Vgs are negative on the part. */
export const MOSFET_MODELS: Readonly<Record<string, MosfetModel>> = {
  IRLZ44N: { vth: 1.5, rdsOn: 0.025, vgsOn: 5 },
  IRF540N: { vth: 3, rdsOn: 0.044, vgsOn: 10 },
  IRF9540N: { vth: 3, rdsOn: 0.117, vgsOn: 10 },
};

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
});
