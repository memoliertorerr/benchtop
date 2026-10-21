/**
 * Environment parts (BT55): the room's ambient conditions and the sources and bodies placed in
 * it. They have no models — the bench's environment runtime (`@benchtop/core` env/) owns them
 * and takes their inputs: `set:<prop>=<v>` channels change a value while running, press/release
 * (or `set:on=1|0`) switch a source, `set:on` starts and stops a body's patrol. Sizes are drawn
 * for the default scale (1 bench mm = 1 room cm); the view scales bodies to their room size.
 */

import type { PinDef } from '@benchtop/core';
import { definePart } from '../define.ts';

/** The overlay prop's values, in `OVERLAY_FIELDS` order (0 = off). */
export const OVERLAY_NAMES = ['off', 'gas', 'temperature', 'light', 'sound'] as const;

/** An optional IN/GND control pair on the 0.1" pitch along a source's bottom edge. */
function controlPins(w: number, h: number): PinDef[] {
  const x = w / 2 - 1.27;
  return [
    { name: 'IN', x, y: h, role: 'digital' },
    { name: 'GND', x: x + 2.54, y: h, role: 'ground' },
  ];
}

export const environment = definePart({
  type: 'environment',
  title: 'Environment (room)',
  category: 'environment',
  size: { w: 30, h: 20 },
  pins: [],
  defaults: {
    temperature: 22,
    humidity: 45,
    light: 300,
    sound: 35,
    gas: 0,
    ventilation: 0.5,
    mixing: 0.02,
    roomWidth: 4,
    roomDepth: 3,
    layer: 0.3,
    heatLoss: 0.02,
    scale: 10,
    overlay: 'off',
  },
});

export const gasLeak = definePart({
  type: 'gas-leak',
  title: 'Gas leak',
  category: 'environment',
  size: { w: 14, h: 14 },
  pins: [],
  defaults: { rate: 2, on: true },
});

export const heater = definePart({
  type: 'heater',
  title: 'Heater',
  category: 'environment',
  size: { w: 20, h: 12 },
  pins: controlPins(20, 12),
  defaults: { watts: 200, on: false },
});

export const flame = definePart({
  type: 'flame',
  title: 'Flame (candle)',
  category: 'environment',
  size: { w: 10, h: 10 },
  pins: [],
  defaults: { strength: 1, on: true },
});

export const lamp = definePart({
  type: 'lamp',
  title: 'Lamp',
  category: 'environment',
  size: { w: 14, h: 14 },
  pins: controlPins(14, 14),
  defaults: { lumens: 800, on: true },
});

export const soundSource = definePart({
  type: 'sound-source',
  title: 'Sound source',
  category: 'environment',
  size: { w: 14, h: 14 },
  pins: [],
  defaults: { db: 80, on: true },
});

export const fan = definePart({
  type: 'fan',
  title: 'Extractor fan',
  category: 'environment',
  size: { w: 16, h: 16 },
  pins: controlPins(16, 16),
  defaults: { flow: 3, on: false },
});

export const person = definePart({
  type: 'person',
  title: 'Person',
  category: 'environment',
  size: { w: 40, h: 40 },
  pins: [],
  defaults: { toX: 200, toY: 0, speed: 1, pause: 1, on: true },
});

export const roomObject = definePart({
  type: 'object',
  title: 'Object (box)',
  category: 'environment',
  size: { w: 40, h: 20 },
  pins: [],
  defaults: { width: 40, depth: 20, toX: 0, toY: 0, speed: 0, pause: 1, on: true },
});

export const ENVIRONMENT_PARTS = [environment, gasLeak, heater, flame, lamp, soundSource, fan, person, roomObject] as const;
