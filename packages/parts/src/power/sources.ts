/**
 * Power sources (BT83): batteries, a bench supply and a ground symbol. `PinDef.volts` is static,
 * so a source whose volts depend on its type or a prop drives its pins from its model — + at
 * its volts, − at 0 V, both at supply strength, as the ESP32 DevKit's model drives VIN (BT44).
 * The resolver and the analog layer treat that like any supply: LEDs and modules run from it,
 * and two different supplies on one net are a `supply-fight`. Volts are nominal and ideal (no
 * internal resistance, no discharge) and absolute against the bench's one ground: a battery's −
 * is 0 V, so stacking batteries in series is a drive fight, not their sum (Later).
 *
 * Sizes and pins are our own drawings' (apps/web/src/views/power.ts), terminals on the 2.54 mm
 * grid so leads land in breadboard holes.
 */

import { type PartDefinition, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { readChannelInput } from '../shared/channel-input.ts';
import { FightWatch } from './fight.ts';

/** The bench supply's range, volts. */
export const BENCH_SUPPLY_MAX = 30;

interface BatterySpec {
  type: string;
  title: string;
  volts: number;
  size: { w: number; h: number };
  /** The + and − terminals (or lead ends), mm. */
  plus: { x: number; y: number };
  minus: { x: number; y: number };
}

function battery(spec: BatterySpec): PartDefinition {
  return definePart({
    type: spec.type,
    title: spec.title,
    category: 'power',
    size: spec.size,
    pins: [
      { name: '+', x: spec.plus.x, y: spec.plus.y, role: 'power' },
      { name: '-', x: spec.minus.x, y: spec.minus.y, role: 'ground' },
    ],
    defaults: {},
    createModel(ctx) {
      const plus = ctx.pin('+');
      const minus = ctx.pin('-');
      const watches = [new FightWatch(ctx, plus, 'Its + terminal'), new FightWatch(ctx, minus, 'Its − terminal')];
      watches[0].target = spec.volts;
      plus.driveVolts(spec.volts, Strength.supply);
      minus.driveVolts(0, Strength.supply);
      return {
        reset() {
          for (const watch of watches) watch.check();
        },
      };
    },
  });
}

/** Nominal volts per battery type (for docs, tests and the drawings' labels). */
export const BATTERY_VOLTS: Readonly<Record<string, number>> = {
  'battery-9v': 9,
  'battery-2aa': 3,
  'battery-4aa': 6,
  'battery-lipo': 3.7,
  'battery-cr2032': 3,
};

/** A 9 V block seen from its large face, the snap terminals at the top (12.7 mm apart). */
export const battery9v = battery({ type: 'battery-9v', title: '9 V battery', volts: 9, size: { w: 26.5, h: 48.5 }, plus: { x: 6.9, y: 3.2 }, minus: { x: 19.6, y: 3.2 } });

/** Two AA cells in a holder, its red and black leads ending above it. */
export const battery2aa = battery({ type: 'battery-2aa', title: '2 × AA battery holder', volts: 3, size: { w: 33, h: 62 }, plus: { x: 13.92, y: 2.54 }, minus: { x: 19.0, y: 2.54 } });

/** Four AA cells side by side in a holder. */
export const battery4aa = battery({ type: 'battery-4aa', title: '4 × AA battery holder', volts: 6, size: { w: 63, h: 62 }, plus: { x: 28.96, y: 2.54 }, minus: { x: 34.04, y: 2.54 } });

/** A one-cell LiPo pouch with its lead and connector. */
export const batteryLipo = battery({ type: 'battery-lipo', title: 'LiPo battery (1S, 3.7 V)', volts: 3.7, size: { w: 34, h: 56 }, plus: { x: 14.46, y: 2.54 }, minus: { x: 19.54, y: 2.54 } });

/** A CR2032 coin cell in a through-hole holder, legs below. */
export const batteryCr2032 = battery({ type: 'battery-cr2032', title: 'CR2032 coin cell (holder)', volts: 3, size: { w: 25.4, h: 30 }, plus: { x: 10.16, y: 27.94 }, minus: { x: 15.24, y: 27.94 } });

/**
 * A bench power supply: + at `volts` (0–30 V), − at 0 V. Running, the Inspector's slider (a
 * `value` input, or the channel `volts`) turns it: the drive follows at once.
 */
export const benchSupply = definePart({
  type: 'bench-supply',
  title: 'Bench power supply',
  category: 'power',
  size: { w: 64, h: 44 },
  pins: [
    { name: '+', x: 40.64, y: 37.5, role: 'power' },
    { name: '-', x: 50.8, y: 37.5, role: 'ground' },
  ],
  defaults: { volts: 5 },
  createModel(ctx, props) {
    const plus = ctx.pin('+');
    const minus = ctx.pin('-');
    const watches = [new FightWatch(ctx, plus, 'Its + output'), new FightWatch(ctx, minus, 'Its − output')];
    const visual = { volts: 0 };
    const set = (volts: number): void => {
      const v = Math.min(BENCH_SUPPLY_MAX, Math.max(0, Number.isFinite(volts) ? volts : 0));
      visual.volts = Math.round(v * 100) / 100;
      watches[0].target = v;
      plus.driveVolts(v, Strength.supply);
      watches[0].check();
      ctx.invalidate();
    };
    minus.driveVolts(0, Strength.supply);
    set(Number(props.volts));
    return {
      input(event) {
        if (event.kind === 'value') set(event.value);
        const channel = readChannelInput(event);
        if (channel?.channel === 'volts') set(channel.value);
      },
      visual: () => visual,
      reset() {
        set(Number(props.volts));
      },
    };
  },
});

/** A ground symbol: one pin at 0 V (a supply pin, like a board's GND). */
export const ground = definePart({
  type: 'ground',
  title: 'Ground',
  category: 'power',
  size: { w: 7.62, h: 7.62 },
  pins: [{ name: 'GND', x: 3.81, y: 0.6, role: 'ground', volts: 0 }],
  defaults: {},
});

export const POWER_SOURCES: readonly PartDefinition[] = [battery9v, battery2aa, battery4aa, batteryLipo, batteryCr2032, benchSupply, ground];
