/**
 * Diodes of the LED-type parts, for the bench's analog layer (BT21): `analogSpecFor(type, props)`
 * goes into `BenchOptions.analogSpecFor`. Piecewise-linear LEDs: knee voltage by color (decided:
 * red 1.8, orange 1.9, yellow 1.9, green 2.0, blue 2.8, white 2.8, purple 2.8 V; anything else
 * 2.0 V) and 10 Ω above it.
 */

import type { AnalogSpec, DiodeSpec, PartProps } from '@benchtop/core';

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
    default:
      return undefined;
  }
}
