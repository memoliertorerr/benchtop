/**
 * Controls for values a part's element can't set itself (light, temperature, sound level, a
 * motion event, a tilt). UI-only: the Inspector shows them for a selected part. While stopped a
 * slider edits the part's prop (the initial value); while running it sends part input only and
 * leaves the document alone (decided: a prop edit mid-run would rebuild the bench).
 */

import type { PartInput } from '@benchtop/core';

export interface SliderControl {
  kind: 'slider';
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  /** The prop holding the initial value; running, the slider sends { kind: 'value' }. */
  prop: string;
  /** Logarithmic travel (min > 0). */
  log?: boolean;
  /** Running, send a channel input (`set:<channel>=<v>`) instead of { kind: 'value' }. */
  channel?: string;
}

export interface ButtonControl {
  kind: 'button';
  label: string;
  /** Sent while running. */
  input: PartInput;
  /** While stopped, toggles this boolean prop instead (otherwise the button is disabled). */
  toggleProp?: string;
}

/** A boolean: stopped it edits the prop; running it sends `set:<channel>=1|0` (BT55). */
export interface ToggleControl {
  kind: 'toggle';
  label: string;
  prop: string;
  channel: string;
}

/** A choice among names: stopped it edits the prop; running it sends `set:<channel>=<index>` (BT55). */
export interface SelectControl {
  kind: 'select';
  label: string;
  prop: string;
  channel: string;
  options: readonly string[];
}

export type Control = SliderControl | ButtonControl | ToggleControl | SelectControl;

const slider = (label: string, unit: string, min: number, max: number, step: number, prop: string, log = false): SliderControl => ({
  kind: 'slider',
  label,
  unit,
  min,
  max,
  step,
  prop,
  channel: prop,
  ...(log ? { log } : {}),
});
const toggle = (label: string, prop = 'on'): ToggleControl => ({ kind: 'toggle', label, prop, channel: prop });

const press: PartInput = { kind: 'press' };

export const CONTROLS: Readonly<Record<string, readonly Control[]>> = {
  'photoresistor-sensor': [{ kind: 'slider', label: 'Light', unit: 'lux', min: 0.1, max: 100_000, step: 0.01, prop: 'lux', log: true }],
  'ntc-temperature-sensor': [{ kind: 'slider', label: 'Temperature', unit: '°C', min: -40, max: 125, step: 0.5, prop: 'temperature' }],
  'small-sound-sensor': [
    { kind: 'slider', label: 'Sound level', unit: '', min: 0, max: 1, step: 0.01, prop: 'level' },
    { kind: 'button', label: 'Clap', input: press },
  ],
  'big-sound-sensor': [
    { kind: 'slider', label: 'Sound level', unit: '', min: 0, max: 1, step: 0.01, prop: 'level' },
    { kind: 'button', label: 'Clap', input: press },
  ],
  'pir-motion-sensor': [{ kind: 'button', label: 'Motion', input: press }],
  'tilt-switch': [{ kind: 'button', label: 'Tilt', input: press, toggleProp: 'tilted' }],
  dht22: [
    { kind: 'slider', label: 'Temperature', unit: '°C', min: -40, max: 80, step: 0.1, prop: 'temperature', channel: 'temperature' },
    { kind: 'slider', label: 'Humidity', unit: '%', min: 0, max: 100, step: 0.1, prop: 'humidity', channel: 'humidity' },
  ],
  'flame-sensor': [{ kind: 'slider', label: 'Flame (infrared)', unit: '', min: 0, max: 1, step: 0.01, prop: 'intensity' }],
  'gas-sensor': [{ kind: 'slider', label: 'Gas', unit: 'ppm', min: 1, max: 10_000, step: 1, prop: 'ppm', log: true }],
  hx711: [{ kind: 'slider', label: 'Weight', unit: 'g', min: 0, max: 50_000, step: 1, prop: 'weight' }],
  'bench-supply': [slider('Voltage', 'V', 0, 30, 0.1, 'volts')], // BT83
  'hc-sr04': [{ kind: 'slider', label: 'Distance', unit: 'cm', min: 2, max: 450, step: 1, prop: 'distance', channel: 'distance' }],
  // BT55: the room and its sources take channel inputs while running (the environment's own).
  environment: [
    slider('Temperature', '°C', -20, 50, 0.5, 'temperature'),
    slider('Humidity', '%', 0, 100, 1, 'humidity'),
    slider('Light', 'lux', 0.1, 100_000, 0.01, 'light', true),
    slider('Sound', 'dB', 20, 120, 1, 'sound'),
    slider('Gas', 'ppm', 0, 5000, 10, 'gas'),
    slider('Ventilation', 'ACH', 0, 30, 0.5, 'ventilation'),
    { kind: 'select', label: 'Heatmap', prop: 'overlay', channel: 'overlay', options: ['off', 'gas', 'temperature', 'light', 'sound'] },
  ],
  'gas-leak': [slider('Leak', 'L/min', 0, 20, 0.1, 'rate'), toggle('Open')],
  heater: [slider('Power', 'W', 0, 2000, 10, 'watts'), toggle('On')],
  flame: [slider('Strength', '', 0, 5, 0.1, 'strength'), toggle('Lit')],
  lamp: [slider('Light', 'lm', 0, 5000, 10, 'lumens'), toggle('On')],
  'sound-source': [slider('Level at 1 m', 'dB', 30, 120, 1, 'db'), toggle('On')],
  fan: [slider('Flow', 'm³/min', 0, 20, 0.1, 'flow'), toggle('On')],
  person: [slider('Speed', 'm/s', 0, 3, 0.05, 'speed'), toggle('Walking')],
  object: [slider('Speed', 'm/s', 0, 3, 0.05, 'speed'), toggle('Moving')],
  mpu6050: [
    ...(['ax', 'ay', 'az'] as const).map((axis): SliderControl => ({ kind: 'slider', label: `Accel ${axis[1].toUpperCase()}`, unit: 'g', min: -2, max: 2, step: 0.01, prop: axis, channel: axis })),
    ...(['gx', 'gy', 'gz'] as const).map((axis): SliderControl => ({ kind: 'slider', label: `Gyro ${axis[1].toUpperCase()}`, unit: '°/s', min: -250, max: 250, step: 1, prop: axis, channel: axis })),
    { kind: 'slider', label: 'Temperature', unit: '°C', min: -40, max: 85, step: 0.5, prop: 'temp', channel: 'temp' },
  ],
};

/** Slider position (0..1000) ↔ value, linear or logarithmic. */
export function sliderToValue(control: SliderControl, position: number): number {
  const t = position / 1000;
  if (control.log) return 10 ** (Math.log10(control.min) + t * (Math.log10(control.max) - Math.log10(control.min)));
  return control.min + t * (control.max - control.min);
}

export function valueToSlider(control: SliderControl, value: number): number {
  const v = Math.min(control.max, Math.max(control.min, value));
  const t = control.log
    ? (Math.log10(v) - Math.log10(control.min)) / (Math.log10(control.max) - Math.log10(control.min))
    : (v - control.min) / (control.max - control.min);
  return Math.round(t * 1000);
}

/** Rounds a slider value to the control's step (log sliders: three significant digits). */
export function roundToStep(control: SliderControl, value: number): number {
  if (control.log) return Number(value.toPrecision(3));
  return Math.round(value / control.step) * control.step;
}
