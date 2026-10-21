/**
 * `envSpecFor(type, props)` for the bench's environment (BT55, `BenchOptions.envSpecFor`): the
 * room, its sources and bodies (environment/parts.ts) and every catalog sensor that samples it.
 * A sensor gets the world's value through the input it already takes, so the sensors' own
 * files don't change:
 *
 * | Sensor | Field | Delivered as | Cone |
 * |---|---|---|---|
 * | gas-sensor (MQ-2) | gas ppm | value | — |
 * | flame-sensor | flame IR 0..1 | value | ±30°, 1.5 m, looking left (its IR receiver's end) |
 * | dht22 | temperature °C, humidity %RH | channels `temperature`, `humidity` | — |
 * | ntc-temperature-sensor | temperature °C | value | — |
 * | photoresistor-sensor | light lux | value | — |
 * | small/big-sound-sensor | sound dB → level (dB − 40)/60, 0..1 | value | — |
 * | pir-motion-sensor | a warm body walking in view | press every 50 ms | ±55°, 7 m |
 * | hc-sr04 | the nearest body, m → cm (0 = none) | channel `distance` | ±15°, 4 m |
 *
 * Cones look up the screen (the part's local −y) unless noted, turned with the part.
 * | mpu6050 | temperature °C | channel `temp` | — |
 */

import type { AmbientSpec, EnvSpec, PartProps } from '@benchtop/core';
import { OVERLAY_NAMES } from './parts.ts';

const num = (props: PartProps, key: string, fallback: number): number => {
  const v = props[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};
const flag = (props: PartProps, key: string, fallback: boolean): boolean => (typeof props[key] === 'boolean' ? (props[key] as boolean) : fallback);

/** The sound modules' level from a sound pressure level: 40 dB → 0, 100 dB → 1. */
export function soundLevel(db: number): number {
  return Math.min(1, Math.max(0, (db - 40) / 60));
}

const SENSORS: Readonly<Record<string, EnvSpec>> = {
  'gas-sensor': { role: 'sensor', samples: [{ field: 'gas', deliver: { kind: 'value' }, epsilon: 1 }] },
  // The IR receiver sits at the module's left end, looking left.
  'flame-sensor': { role: 'sensor', samples: [{ field: 'flame', deliver: { kind: 'value' }, epsilon: 0.002 }], cone: { halfAngleDeg: 30, range: 1.5, facing: { x: -1, y: 0 } } },
  dht22: {
    role: 'sensor',
    samples: [
      { field: 'temperature', deliver: { kind: 'channel', channel: 'temperature' }, epsilon: 0.05 },
      { field: 'humidity', deliver: { kind: 'channel', channel: 'humidity' }, epsilon: 0.1 },
    ],
  },
  'ntc-temperature-sensor': { role: 'sensor', samples: [{ field: 'temperature', deliver: { kind: 'value' }, epsilon: 0.05 }] },
  'photoresistor-sensor': { role: 'sensor', samples: [{ field: 'light', deliver: { kind: 'value' }, epsilon: 0.5 }] },
  'small-sound-sensor': { role: 'sensor', samples: [{ field: 'sound', deliver: { kind: 'value' }, map: soundLevel, epsilon: 0.005 }] },
  'big-sound-sensor': { role: 'sensor', samples: [{ field: 'sound', deliver: { kind: 'value' }, map: soundLevel, epsilon: 0.005 }] },
  'pir-motion-sensor': { role: 'sensor', samples: [{ field: 'motion', deliver: { kind: 'press-while' }, epsilon: 0 }], cone: { halfAngleDeg: 55, range: 7 } },
  'hc-sr04': {
    role: 'sensor',
    samples: [{ field: 'distance', deliver: { kind: 'channel', channel: 'distance' }, map: (m) => Math.round(m * 1000) / 10, epsilon: 0.5 }],
    cone: { halfAngleDeg: 15, range: 4 },
  },
  mpu6050: { role: 'sensor', samples: [{ field: 'temperature', deliver: { kind: 'channel', channel: 'temp' }, epsilon: 0.05 }] },
};

/** Part types that sample the environment (the Inspector says so instead of offering sliders). */
export const ENV_SENSOR_TYPES: ReadonlySet<string> = new Set(Object.keys(SENSORS));

export function envSpecFor(type: string, props: PartProps): EnvSpec | undefined {
  switch (type) {
    case 'environment': {
      const overlay = OVERLAY_NAMES.indexOf(String(props.overlay) as (typeof OVERLAY_NAMES)[number]);
      const ambient: AmbientSpec = {
        temperature: num(props, 'temperature', 22),
        humidity: num(props, 'humidity', 45),
        light: num(props, 'light', 300),
        sound: num(props, 'sound', 35),
        gas: num(props, 'gas', 0),
        ventilation: num(props, 'ventilation', 0.5),
        mixing: num(props, 'mixing', 0.02),
        roomWidth: num(props, 'roomWidth', 4),
        roomDepth: num(props, 'roomDepth', 3),
        layer: num(props, 'layer', 0.3),
        heatLoss: num(props, 'heatLoss', 0.02),
        scale: num(props, 'scale', 10),
        overlay: overlay < 0 ? 0 : overlay,
      };
      return { role: 'ambient', ambient };
    }
    case 'gas-leak':
      return { role: 'source', source: { kind: 'gas', params: { rate: num(props, 'rate', 2) }, on: flag(props, 'on', true) } };
    case 'heater':
      return { role: 'source', source: { kind: 'heat', params: { watts: num(props, 'watts', 200) }, on: flag(props, 'on', false), control: { pin: 'IN', ground: 'GND' } } };
    case 'flame':
      return { role: 'source', source: { kind: 'flame', params: { strength: num(props, 'strength', 1) }, on: flag(props, 'on', true) } };
    case 'lamp':
      return { role: 'source', source: { kind: 'light', params: { lumens: num(props, 'lumens', 800) }, on: flag(props, 'on', true), control: { pin: 'IN', ground: 'GND' } } };
    case 'sound-source':
      return { role: 'source', source: { kind: 'sound', params: { db: num(props, 'db', 80) }, on: flag(props, 'on', true) } };
    case 'fan':
      return { role: 'source', source: { kind: 'fan', params: { flow: num(props, 'flow', 3) }, on: flag(props, 'on', false), control: { pin: 'IN', ground: 'GND' } } };
    case 'person':
    case 'object':
      return {
        role: 'body',
        body: {
          shape: type === 'person' ? { kind: 'circle', radius: 0.2 } : { kind: 'box', w: Math.max(1, num(props, 'width', 40)) / 100, h: Math.max(1, num(props, 'depth', 20)) / 100 },
          warm: type === 'person',
          toX: num(props, 'toX', 0),
          toY: num(props, 'toY', 0),
          speed: num(props, 'speed', 0),
          pause: num(props, 'pause', 1),
          on: flag(props, 'on', true),
        },
      };
    default:
      return SENSORS[type];
  }
}
