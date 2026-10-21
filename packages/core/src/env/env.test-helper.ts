/**
 * Test parts for the environment's bench tests (BT54): a room, a leak, a heater with a control
 * input, a walker, a supply, and sensors whose models log every input with its time.
 */

import { Bench } from '../bench/bench.ts';
import type { PartDefinition, PartInput, PartProps } from '../contracts/part.ts';
import type { PartInstance, ProjectDoc } from '../contracts/project.ts';
import { makeBenchEnv } from '../testing.ts';
import type { AmbientSpec, EnvSpec } from './spec.ts';

export interface Logged {
  t: number;
  input: PartInput;
}

/** Each logging sensor's inputs, by its `log` prop. */
export const logs = new Map<string, Logged[]>();

const pinless = (type: string, defaults: PartProps = {}): PartDefinition => ({ type, title: type, category: 'test', size: { w: 10, h: 10 }, pins: [], defaults });

/** A sensor whose model logs every input with its time, under the part id in its `log` prop. */
const loggingSensor: PartDefinition = {
  type: 'sensor',
  title: 'sensor',
  category: 'test',
  size: { w: 10, h: 10 },
  pins: [],
  defaults: { log: '' },
  createModel(ctx, props) {
    const list: Logged[] = [];
    logs.set(String(props.log), list);
    return { input: (input) => void list.push({ t: ctx.now(), input }) };
  },
};

const DEFS: readonly PartDefinition[] = [
  pinless('room', { temperature: 20, humidity: 50, light: 100, sound: 30, gas: 400, ventilation: 0, mixing: 0.05, roomWidth: 4, roomDepth: 3, layer: 0.3, heatLoss: 0, scale: 10, overlay: 1 }),
  pinless('leak', { rate: 2, on: true }),
  pinless('walker', { toX: 200, toY: 0, speed: 1, pause: 0, on: true }),
  {
    type: 'heater',
    title: 'heater',
    category: 'test',
    size: { w: 10, h: 10 },
    pins: [
      { name: 'IN', x: 0, y: 10, role: 'digital' },
      { name: 'GND', x: 2.54, y: 10, role: 'ground' },
    ],
    defaults: { watts: 200, on: false },
  },
  { type: 'supply', title: 'supply', category: 'test', size: { w: 5, h: 5 }, pins: [{ name: 'V', x: 0, y: 0, role: 'power', volts: 5 }], defaults: {} },
  loggingSensor,
  { ...loggingSensor, type: 'pir' },
];

export function envSpecFor(type: string, props: PartProps): EnvSpec | undefined {
  const n = (k: string): number => Number(props[k]);
  switch (type) {
    case 'room':
      return { role: 'ambient', ambient: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, Number(v)])) as unknown as AmbientSpec };
    case 'leak':
      return { role: 'source', source: { kind: 'gas', params: { rate: n('rate') }, on: props.on === true } };
    case 'heater':
      return { role: 'source', source: { kind: 'heat', params: { watts: n('watts') }, on: props.on === true, control: { pin: 'IN', ground: 'GND' } } };
    case 'walker':
      return { role: 'body', body: { shape: { kind: 'circle', radius: 0.2 }, warm: true, toX: n('toX'), toY: n('toY'), speed: n('speed'), pause: n('pause'), on: props.on === true } };
    case 'sensor':
      return {
        role: 'sensor',
        samples: [
          { field: 'gas', deliver: { kind: 'value' }, epsilon: 1 },
          { field: 'temperature', deliver: { kind: 'channel', channel: 'temperature' }, epsilon: 0.01 },
        ],
      };
    case 'pir':
      return { role: 'sensor', samples: [{ field: 'motion', deliver: { kind: 'press-while' }, epsilon: 0 }], cone: { halfAngleDeg: 55, range: 7 } };
    default:
      return undefined;
  }
}

export const part = (id: string, type: string, x: number, y: number, props: PartProps = {}): PartInstance => ({ id, type, x, y, rotation: 0, props });

export function doc(parts: PartInstance[], wires: ProjectDoc['wires'] = []): ProjectDoc {
  return { format: 1, name: 'env', parts, wires, firmware: {} };
}

export function bench(d: ProjectDoc): Bench {
  const b = new Bench(d, makeBenchEnv(DEFS), { envSpecFor });
  b.reset();
  return b;
}

