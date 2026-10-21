/**
 * 7-segment displays with 1, 2 or 4 digits (one part type each: their pinouts differ, and a
 * part type's pins are fixed). Prop `common`: 'cathode' (a segment of digit d is lit while its
 * segment pin is 1 and the digit's common pin is 0) or 'anode' (common at 1, segment at 0).
 * Brightness per segment per digit is the duty cycle from edge timestamps (shared/duty.ts), so
 * a multiplexed display reads ~1/digits per lit segment. The 4-digit colon is lit while CLN and
 * COM are driven like a segment and its digit. Visual `values`: 8 numbers per digit, segments
 * A, B, C, D, E, F, G, DP, plus `colon`. Pins from @wokwi/elements 1.9.2 7segment-element
 * (pins="top").
 */

import { ANALOG_PROP, type NetState, type PartContext, type PinDef, type PinHandle, Strength } from '@benchtop/core';
import { LED_RS_OHMS, ledVf } from '../analog-specs.ts';
import { definePart } from '../define.ts';
import { DiodeLight, OvercurrentReport } from '../shared/diode-light.ts';
import { DutyChannel } from '../shared/duty.ts';

const SEGMENTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'] as const;

const on = (s: NetState): boolean => s.level === 1 && s.strength >= Strength.weak;

/** Lit while `plus` is driven high and `minus` low (an LED's anode and cathode). */
function litBetween(plus: PinHandle, minus: PinHandle): boolean {
  return on(plus.read()) && minus.read().level === 0;
}

function sevenSegmentModel(
  ctx: PartContext,
  commons: readonly string[],
  props: { common: string | number | boolean; color: string | number | boolean },
  colonPins?: { cln: string; com: string },
) {
  const anode = props.common === 'anode';
  const segments = SEGMENTS.map((name) => ctx.pin(name));
  const digits = commons.map((name) => ctx.pin(name));
  if ((props as Record<string, unknown>)[ANALOG_PROP] === true) return analogSevenSegment(ctx, segments, digits, anode, ledVf(props.color), colonPins);
  const channels = digits.flatMap(() => SEGMENTS.map(() => new DutyChannel(ctx)));
  const values: number[] = new Array<number>(channels.length).fill(0);
  const cln = colonPins === undefined ? undefined : ctx.pin(colonPins.cln);
  const com = colonPins === undefined ? undefined : ctx.pin(colonPins.com);
  const colon = new DutyChannel(ctx);
  const visual = { values, colon: 0 };
  const update = (): void => {
    for (let d = 0; d < digits.length; d++) {
      const digit = digits[d];
      for (let s = 0; s < 8; s++) {
        channels[d * 8 + s].set(anode ? litBetween(digit, segments[s]) : litBetween(segments[s], digit));
      }
    }
    if (cln !== undefined && com !== undefined) colon.set(anode ? litBetween(com, cln) : litBetween(cln, com));
  };
  for (const pin of segments) pin.onChange(update);
  for (const pin of digits) pin.onChange(update);
  cln?.onChange(update);
  com?.onChange(update);
  return {
    visual() {
      for (let i = 0; i < channels.length; i++) values[i] = channels[i].brightness;
      visual.colon = colon.brightness;
      return visual;
    },
    reset() {
      for (const channel of channels) channel.reset();
      colon.reset();
      ctx.invalidate();
    },
  };
}

/** The display under the analog layer: one DiodeLight per segment per digit (and the colon). */
function analogSevenSegment(ctx: PartContext, segments: PinHandle[], digits: PinHandle[], anode: boolean, vf: number, colonPins?: { cln: string; com: string }) {
  const light = (seg: PinHandle, common: PinHandle): DiodeLight => (anode ? new DiodeLight(ctx, common, seg, vf, LED_RS_OHMS) : new DiodeLight(ctx, seg, common, vf, LED_RS_OHMS));
  const diodes = digits.flatMap((digit) => segments.map((seg) => light(seg, digit)));
  const cln = colonPins === undefined ? undefined : ctx.pin(colonPins.cln);
  const com = colonPins === undefined ? undefined : ctx.pin(colonPins.com);
  const colon = cln !== undefined && com !== undefined ? light(cln, com) : undefined;
  const over = new OvercurrentReport(ctx);
  const values: number[] = new Array<number>(diodes.length).fill(0);
  const visual = { values, colon: 0 };
  const update = (): void => {
    let max = 0;
    for (const d of diodes) {
      d.update();
      if (d.amps > max) max = d.amps;
    }
    if (colon !== undefined) {
      colon.update();
      if (colon.amps > max) max = colon.amps;
    }
    over.update(max);
  };
  for (const pin of segments) pin.onChange(update);
  for (const pin of digits) pin.onChange(update);
  cln?.onChange(update);
  com?.onChange(update);
  return {
    visual() {
      for (let i = 0; i < diodes.length; i++) values[i] = diodes[i].brightness;
      visual.colon = colon?.brightness ?? 0;
      return visual;
    },
    reset() {
      for (const d of diodes) d.reset();
      colon?.reset();
      over.reset();
      update();
      ctx.invalidate();
    },
  };
}

const segmentPin = (name: string, x: number, y: number): PinDef => ({ name, x, y, role: 'passive' });

export const sevenSegment = definePart({
  type: 'seven-segment',
  title: '7-segment (1 digit)',
  category: 'displays',
  size: { w: 12.55, h: 22 },
  pins: [
    segmentPin('COM.1', 6.276, 19.002),
    segmentPin('COM.2', 6.276, 1),
    segmentPin('A', 8.816, 1),
    segmentPin('B', 11.356, 1),
    segmentPin('C', 8.816, 19.002),
    segmentPin('D', 3.735, 19.002),
    segmentPin('E', 1.195, 19.002),
    segmentPin('F', 3.735, 1),
    segmentPin('G', 1.195, 1),
    segmentPin('DP', 11.356, 19.002),
  ],
  buses: [['COM.1', 'COM.2']],
  defaults: { common: 'cathode', color: 'red' },
  createModel: (ctx, props) => sevenSegmentModel(ctx, ['COM.1'], props),
});

export const sevenSegment2 = definePart({
  type: 'seven-segment-2',
  title: '7-segment (2 digits)',
  category: 'displays',
  size: { w: 25.1, h: 22 },
  pins: [
    segmentPin('DIG1', 12.552, 1),
    segmentPin('DIG2', 15.092, 1),
    segmentPin('A', 7.471, 1),
    segmentPin('B', 10.011, 1),
    segmentPin('C', 7.471, 19.002),
    segmentPin('D', 15.092, 19.002),
    segmentPin('E', 12.552, 19.002),
    segmentPin('F', 17.632, 1),
    segmentPin('G', 17.632, 19.002),
    segmentPin('DP', 10.011, 19.002),
  ],
  defaults: { common: 'cathode', color: 'red' },
  createModel: (ctx, props) => sevenSegmentModel(ctx, ['DIG1', 'DIG2'], props),
});

export const sevenSegment4 = definePart({
  type: 'seven-segment-4',
  title: '7-segment (4 digits)',
  category: 'displays',
  size: { w: 50.2, h: 22 },
  pins: [
    segmentPin('A', 20.023, 1),
    segmentPin('B', 30.184, 1),
    segmentPin('C', 25.103, 19.002),
    segmentPin('D', 20.023, 19.002),
    segmentPin('E', 17.482, 19.002),
    segmentPin('F', 22.563, 1),
    segmentPin('G', 27.643, 19.002),
    segmentPin('DP', 22.563, 19.002),
    segmentPin('DIG1', 17.482, 1),
    segmentPin('DIG2', 25.103, 1),
    segmentPin('DIG3', 27.643, 1),
    segmentPin('DIG4', 30.184, 19.002),
    segmentPin('COM', 32.724, 19.002),
    segmentPin('CLN', 32.724, 1),
  ],
  defaults: { common: 'cathode', color: 'red', colon: false },
  createModel: (ctx, props) => sevenSegmentModel(ctx, ['DIG1', 'DIG2', 'DIG3', 'DIG4'], props, { cln: 'CLN', com: 'COM' }),
});

/** Segment patterns (bit s = segment A…G) of the characters `sevenSegmentText` knows. */
const GLYPHS: Readonly<Record<number, string>> = {
  0x00: ' ',
  0x3f: '0',
  0x06: '1',
  0x5b: '2',
  0x4f: '3',
  0x66: '4',
  0x6d: '5',
  0x7d: '6',
  0x07: '7',
  0x7f: '8',
  0x6f: '9',
  0x40: '-',
};

/**
 * What a 7-segment visual shows, one character per digit (BT49; the examples' tests and the CLI's
 * `digits` expectation): a segment counts as lit above 0.05 brightness (multiplexing divides it
 * by the digit count), DP and the colon are ignored, ' ' is a dark digit, '?' a pattern that
 * isn't a digit or '-'.
 */
export function sevenSegmentText(values: readonly number[]): string {
  let out = '';
  for (let d = 0; d < Math.floor(values.length / 8); d++) {
    let bits = 0;
    for (let s = 0; s < 7; s++) if (values[d * 8 + s] > 0.05) bits |= 1 << s;
    out += GLYPHS[bits] ?? '?';
  }
  return out;
}
