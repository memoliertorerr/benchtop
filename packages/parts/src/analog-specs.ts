/**
 * Diodes of the LED-type parts, for the bench's analog layer (BT21): `analogSpecFor(type, props)`
 * goes into `BenchOptions.analogSpecFor`. Piecewise-linear LEDs: knee voltage by color (decided:
 * red 1.8, orange 1.9, yellow 1.9, green 2.0, blue 2.8, white 2.8, purple 2.8 V; anything else
 * 2.0 V) and 10 Ω above it. BT167: capacitors (their `farads`) and the diode part (its model's
 * knee and resistance). BT169: transistors (their models). BT172: a DC motor (dc-motor.ts).
 */

import type { AnalogSpec, DiodeSpec, PartProps } from '@benchtop/core';
import { motorParams } from './actuators/dc-motor.ts';
import { COIL_HENRIES, COIL_OHMS } from './actuators/relay.ts';
import { DIODE_MODELS } from './basic/diode.ts';
import { BJT_MODELS, BJT_RB, BJT_VBE, BODY_DIODE, BREAKDOWN_RS, MOSFET_MODELS } from './basic/transistors.ts';

export const LED_RS_OHMS = 10;

const VF: Readonly<Record<string, number>> = { red: 1.8, orange: 1.9, yellow: 1.9, green: 2.0, blue: 2.8, white: 2.8, purple: 2.8 };

/** Knee voltage of an LED of `color`. */
export function ledVf(color: unknown): number {
  return typeof color === 'string' ? (VF[color.toLowerCase()] ?? 2.0) : 2.0;
}

/** The bar graph's palettes (as its element draws them), bar 1 first. */
const PALETTES: Readonly<Record<string, readonly string[]>> = {
  GYR: ['green', 'green', 'green', 'green', 'green', 'yellow', 'yellow', 'yellow', 'red', 'red'],
  BCYR: ['blue', 'cyan', 'cyan', 'cyan', 'cyan', 'yellow', 'yellow', 'yellow', 'red', 'red'],
};

/** Color of bar `i` (0-based) of a bar graph with prop `color`. */
export function barColor(color: unknown, i: number): string {
  const palette = typeof color === 'string' ? PALETTES[color] : undefined;
  return palette?.[i] ?? (typeof color === 'string' ? color : 'red');
}

const diode = (anode: string, cathode: string, color: unknown): DiodeSpec => ({ anode, cathode, vf: ledVf(color), rs: LED_RS_OHMS });

/** BT177: a 1N4007's diode between two pins. */
const diode1n4007 = (anode: string, cathode: string): DiodeSpec => ({ anode, cathode, vf: DIODE_MODELS['1N4007'].vf, rs: DIODE_MODELS['1N4007'].rs });

const SEGMENTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'];
const DIGIT_COMMONS: Readonly<Record<string, readonly string[]>> = {
  'seven-segment': ['COM.1'],
  'seven-segment-2': ['DIG1', 'DIG2'],
  'seven-segment-4': ['DIG1', 'DIG2', 'DIG3', 'DIG4'],
};

export function analogSpecFor(type: string, props: PartProps): AnalogSpec | undefined {
  switch (type) {
    case 'led':
      return { diodes: [diode('A', 'C', props.color)] };
    case 'rgb-led': {
      const anode = props.common === 'anode';
      const colors: [string, string][] = [
        ['R', 'red'],
        ['G', 'green'],
        ['B', 'blue'],
      ];
      return { diodes: colors.map(([pin, color]) => (anode ? diode('COM', pin, color) : diode(pin, 'COM', color))) };
    }
    case 'led-bar-graph':
      return { diodes: Array.from({ length: 10 }, (_, i) => diode(`A${i + 1}`, `C${i + 1}`, barColor(props.color, i))) };
    case 'seven-segment':
    case 'seven-segment-2':
    case 'seven-segment-4': {
      const anode = props.common === 'anode';
      const diodes = (DIGIT_COMMONS[type] ?? []).flatMap((common) => SEGMENTS.map((seg) => (anode ? diode(common, seg, props.color) : diode(seg, common, props.color))));
      if (type === 'seven-segment-4') diodes.push(anode ? diode('COM', 'CLN', props.color) : diode('CLN', 'COM', props.color));
      return { diodes };
    }
    case 'capacitor':
    case 'capacitor-electrolytic': {
      const farads = Number(props.farads);
      const [a, b] = type === 'capacitor' ? ['1', '2'] : ['+', '-'];
      return { diodes: [], capacitors: Number.isFinite(farads) && farads > 0 ? [{ a, b, farads }] : [] };
    }
    case 'diode': {
      const model = DIODE_MODELS[String(props.model)] ?? DIODE_MODELS['1N4148'];
      return { diodes: [{ anode: 'A', cathode: 'C', vf: model.vf, rs: model.rs }] };
    }
    case 'npn-transistor':
    case 'pnp-transistor': {
      const npn = type === 'npn-transistor';
      const m = BJT_MODELS[String(props.model)] ?? BJT_MODELS[npn ? '2N2222A' : '2N3906'];
      // BT177: Vceo breakdown, collector to emitter (a PNP's emitter to collector).
      const breakdown = npn ? { anode: 'C', cathode: 'E', vf: m.vMax, rs: BREAKDOWN_RS } : { anode: 'E', cathode: 'C', vf: m.vMax, rs: BREAKDOWN_RS };
      return { diodes: [breakdown], transistors: [{ kind: npn ? 'npn' : 'pnp', c: 'C', b: 'B', e: 'E', beta: m.beta, vbe: BJT_VBE, rb: BJT_RB, vceSat: m.vceSat, rsat: m.rsat, iMax: m.iMax }] };
    }
    case 'relay-ks2e-m-dc5':
      // BT178: its coil, 125 Ω and 150 mH (a 5 V signal relay's ≈ 1.2 ms).
      return { diodes: [], capacitors: [{ a: 'COIL1', b: 'COIL2', farads: 0, seriesOhms: COIL_OHMS, henries: COIL_HENRIES }] };
    case 'l298n': {
      // BT177: the module's eight flyback diodes (1N4007-like): each OUT to +12V, GND to each OUT.
      const outs = ['OUT1', 'OUT2', 'OUT3', 'OUT4'];
      return { diodes: outs.flatMap((out) => [diode1n4007(out, '+12V'), diode1n4007('GND', out)]) };
    }
    case 'dc-motor': {
      // BT172: the winding in series with the back-EMF's capacitor and the friction's leak.
      const m = motorParams(props);
      return { diodes: [], capacitors: [{ a: '+', b: '-', farads: m.c, seriesOhms: m.rw, parallelOhms: m.rm, henries: m.l }] };
    }
    case 'n-mosfet':
    case 'p-mosfet': {
      const n = type === 'n-mosfet';
      const m = MOSFET_MODELS[String(props.model)] ?? MOSFET_MODELS[n ? 'IRLZ44N' : 'IRF9540N'];
      // BT177: the body diode and the avalanche at Vdss (mirrored on a P-channel).
      const diodes = n
        ? [
            { anode: 'S', cathode: 'D', vf: BODY_DIODE.vf, rs: BODY_DIODE.rs },
            { anode: 'D', cathode: 'S', vf: m.vMax, rs: BREAKDOWN_RS },
          ]
        : [
            { anode: 'D', cathode: 'S', vf: BODY_DIODE.vf, rs: BODY_DIODE.rs },
            { anode: 'S', cathode: 'D', vf: m.vMax, rs: BREAKDOWN_RS },
          ];
      return { diodes, transistors: [{ kind: n ? 'nmos' : 'pmos', d: 'D', g: 'G', s: 'S', vth: m.vth, rdsOn: m.rdsOn, vgsOn: m.vgsOn, iMax: m.iMax }] };
    }
    default:
      return undefined;
  }
}
