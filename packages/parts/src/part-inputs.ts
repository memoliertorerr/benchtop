/**
 * What each part takes as input while a bench runs (BT68): a table read from the parts' models,
 * for tools that drive a bench without the UI — the MCP server's `describe_part`, scripts and
 * test specs. A `PartInput` a part doesn't list is ignored by its model.
 *
 * Kinds, as `PartInput` spells them: `press` / `release`; `value` (one number, in `unit`,
 * clamped to `min`–`max` where given); `key` (named keys, `down` true then false); `channel`
 * (a named value sent as the key event `set:<channel>=<number>`, which scripts write as
 * `{ "set": { "<channel>": <number> } }`). Environment sources take every numeric or boolean prop
 * as a channel (booleans as 1/0).
 */

import { KEYPAD_KEYS } from './inputs/membrane-keypad.ts';
import { IR_REMOTE_KEYS } from './inputs/ir-remote.ts';
import { MPU_CHANNELS } from './sensors/mpu6050.ts';

export type PartInputSpec =
  | { kind: 'press' | 'release'; does: string }
  | { kind: 'value'; does: string; unit: string; min?: number; max?: number }
  | { kind: 'key'; does: string; keys: readonly string[] }
  | { kind: 'channel'; does: string; channel: string; unit: string; min?: number; max?: number };

const press = (does: string): PartInputSpec => ({ kind: 'press', does });
const release = (does: string): PartInputSpec => ({ kind: 'release', does });
const value = (does: string, unit: string, min?: number, max?: number): PartInputSpec => ({ kind: 'value', does, unit, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) });
const channel = (name: string, does: string, unit: string, min?: number, max?: number): PartInputSpec => ({
  kind: 'channel',
  does,
  channel: name,
  unit,
  ...(min === undefined ? {} : { min }),
  ...(max === undefined ? {} : { max }),
});

const button = [press('closes the contact'), release('opens it')];
const potentiometer = [value('wiper position (0 at one end, 1 at the other)', 'fraction', 0, 1)];
const soundModule = [value('sound level at the microphone', 'fraction of full scale', 0, 1), press('a clap: a 100 ms burst')];
const source = (props: readonly [string, string, string][]): PartInputSpec[] => [
  press('switches the source on'),
  release('switches it off'),
  channel('on', 'on (1) or off (0)', 'boolean', 0, 1),
  ...props.map(([name, does, unit]) => channel(name, does, unit)),
];
const body = (): PartInputSpec[] => [
  channel('on', 'starts (1) or stops (0) its patrol', 'boolean', 0, 1),
  channel('toX', 'patrol end, x offset from the part', 'bench mm'),
  channel('toY', 'patrol end, y offset from the part', 'bench mm'),
  channel('speed', 'walking speed', 'm/s'),
  channel('pause', 'pause at each end', 's'),
];

export const PART_INPUTS: Readonly<Record<string, readonly PartInputSpec[]>> = {
  pushbutton: button,
  'slide-switch': [press('flips the switch'), value('position: below 0.5 one side, else the other', 'position', 0, 1)],
  potentiometer,
  'slide-potentiometer': potentiometer,
  'analog-joystick': [
    channel('x', 'horizontal deflection', 'fraction', -1, 1),
    channel('y', 'vertical deflection', 'fraction', -1, 1),
    press('presses the stick (SEL)'),
    release('releases it'),
  ],
  'dip-switch-8': [{ kind: 'key', does: 'down: true toggles that switch', keys: ['1', '2', '3', '4', '5', '6', '7', '8'] }],
  'ky-040': [{ kind: 'key', does: 'down: true turns one detent clockwise or counterclockwise', keys: ['cw', 'ccw'] }, press('presses the shaft button'), release('releases it')],
  'membrane-keypad': [{ kind: 'key', does: 'down: true presses the key, false releases it', keys: KEYPAD_KEYS }],
  'tilt-switch': [press('toggles tilted'), value('tilted when ≥ 0.5', 'boolean', 0, 1)],
  'ir-receiver': [
    {
      kind: 'key',
      does: `"ir:<command code 0–255>" down: true sends an NEC frame (address 0) and repeats while held; down: false releases. The remote's keys: ${Object.entries(IR_REMOTE_KEYS)
        .map(([k, c]) => `${k}=${c}`)
        .join(', ')}`,
      keys: ['ir:<code>'],
    },
  ],
  dht22: [channel('temperature', 'air temperature', '°C', -40, 80), channel('humidity', 'relative humidity', '%', 0, 100)],
  'hc-sr04': [value('distance to the object (≤ 0 or > 400: no echo)', 'cm'), channel('distance', 'the same, as a channel', 'cm')],
  mpu6050: MPU_CHANNELS.map((c) => (c === 'temp' ? channel(c, 'die temperature', '°C') : c.startsWith('a') ? channel(c, `acceleration along ${c[1]}`, 'g') : channel(c, `rotation rate about ${c[1]}`, '°/s'))),
  'ntc-temperature-sensor': [value('temperature', '°C', -55, 150)],
  'photoresistor-sensor': [value('illuminance', 'lux', 0)],
  'pir-motion-sensor': [press('motion: OUT goes high for the hold time')],
  'small-sound-sensor': soundModule,
  'big-sound-sensor': soundModule,
  'flame-sensor': [value('infrared from a flame', 'intensity', 0, 1)],
  'gas-sensor': [value('gas concentration', 'ppm', 0)],
  hx711: [value('weight on the load cell', 'g')],
  'bench-supply': [value('output voltage (BT83)', 'V', 0, 30), channel('volts', 'output voltage', 'V', 0, 30)],
  microphone: [value('one audio sample; the module plays samples at 16 kHz in the order sent', 'fraction of full scale', -1, 1)],
  environment: [
    channel('temperature', 'ambient temperature', '°C'),
    channel('humidity', 'ambient relative humidity', '%'),
    channel('light', 'ambient light', 'lux'),
    channel('sound', 'ambient sound level', 'dB'),
    channel('gas', 'ambient gas concentration', 'ppm'),
    channel('ventilation', 'air changes that clear gas and heat', 'per hour'),
  ],
  'gas-leak': source([['rate', 'leak rate', 'L/min']]),
  heater: source([['watts', 'heating power', 'W']]),
  flame: source([['strength', 'flame size', 'fraction']]),
  lamp: source([['lumens', 'light output', 'lm']]),
  'sound-source': source([['db', 'sound level at 1 m', 'dB']]),
  fan: source([['flow', 'air flow', 'm³/min']]),
  person: body(),
  object: body(),
};

/** The inputs a part type takes (none for parts without any). */
export function partInputs(type: string): readonly PartInputSpec[] {
  return PART_INPUTS[type] ?? [];
}
