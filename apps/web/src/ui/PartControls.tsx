import type { PartInstance } from '@benchtop/core';
import { channelInput, ENV_SENSOR_TYPES } from '@benchtop/parts';
import { signal } from '@preact/signals';
import { editor } from '../editor/app-store.ts';
import { sim, simRunning } from '../sim/host.ts';
import { CONTROLS, roundToStep, type SliderControl, sliderToValue, valueToSlider } from '../views/controls.ts';
import { micState, startMic, stopMic } from './audio/mic.ts';
import { lazyComponent } from './lazy.tsx';

const CardControls = lazyComponent(() => import('./card/CardControls.tsx').then((m) => m.CardControls));

/** The microphone's control (BT41): feed it from the computer's microphone while running. */
function MicControl({ part }: { part: PartInstance }) {
  const running = simRunning.value;
  const { part: listening, state } = micState.value;
  const mine = listening === part.id;
  return (
    <div class="part-controls">
      <div class="field-label">Controls</div>
      <button
        type="button"
        class={`tool-button${mine && state === 'on' ? ' active' : ''}`}
        disabled={!running || (mine && state === 'starting')}
        title={running ? 'Feed this part from your computer’s microphone (nothing is recorded or stored)' : 'Run the bench to use this'}
        onClick={() => (mine ? stopMic() : void startMic(part.id))}
      >
        {mine && state === 'on' ? 'Stop microphone' : mine && state === 'starting' ? 'Starting…' : 'Use microphone'}
      </button>
    </div>
  );
}

/** Values sent while running, by "part:prop"; the document keeps the initial values. */
const live = signal<ReadonlyMap<string, number>>(new Map());

/**
 * BT55: a sensor that samples the room while the bench has an environment part — its sliders
 * would be overwritten by the room, so they give way to a note and an opt-out.
 */
function EnvSensorNote({ part }: { part: PartInstance }) {
  return (
    <div class="part-controls">
      <div class="field-label">Controls</div>
      <p class="muted env-note">Set by the environment: it reads the room where it stands.</p>
      <label class="field field-check">
        <input type="checkbox" checked onChange={() => editor.setProp(part.id, 'followEnvironment', false)} />
        <span class="field-label">Follow the environment</span>
      </label>
    </div>
  );
}

/** The Inspector's live controls for a part (light, temperature, motion …), if it has any. */
export function PartControls({ part, defaults }: { part: PartInstance; defaults: Record<string, unknown> }) {
  if (part.type === 'microphone') return <MicControl part={part} />;
  if (part.type === 'microsd-card') return <CardControls part={part} />;
  if (ENV_SENSOR_TYPES.has(part.type) && part.props.followEnvironment !== false && editor.doc.value.parts.some((p) => p.type === 'environment')) {
    return <EnvSensorNote part={part} />;
  }
  const controls = CONTROLS[part.type];
  if (controls === undefined) return null;
  const running = simRunning.value;
  const values = live.value;
  const propValue = (prop: string): number => {
    const v = part.props[prop] ?? defaults[prop];
    return typeof v === 'number' ? v : 0;
  };
  const slide = (control: SliderControl, position: number): void => {
    const value = roundToStep(control, sliderToValue(control, position));
    if (simRunning.peek()) {
      sim.input(part.id, control.channel === undefined ? { kind: 'value', value } : channelInput(control.channel, value));
      live.value = new Map(live.peek()).set(`${part.id}:${control.prop}`, value);
    } else {
      editor.setProp(part.id, control.prop, value);
    }
  };
  return (
    <div class="part-controls">
      <div class="field-label">Controls {running ? '(live)' : '(initial values)'}</div>
      {controls.map((control) => {
        if (control.kind === 'slider') {
          const value = (running ? values.get(`${part.id}:${control.prop}`) : undefined) ?? propValue(control.prop);
          return (
            <label key={control.label} class="field control-slider">
              <span class="control-row">
                <span>{control.label}</span>
                <span class="control-value">
                  {control.log ? Number(value.toPrecision(3)) : value} {control.unit}
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={1000}
                step={1}
                value={valueToSlider(control, value)}
                onInput={(event) => slide(control, Number((event.target as HTMLInputElement).value))}
              />
            </label>
          );
        }
        if (control.kind === 'toggle') {
          const key = `${part.id}:${control.prop}`;
          const initial = (part.props[control.prop] ?? defaults[control.prop]) === true;
          const checked = running ? (values.get(key) ?? (initial ? 1 : 0)) !== 0 : initial;
          return (
            <label key={control.label} class="field field-check">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  const on = (event.target as HTMLInputElement).checked;
                  if (simRunning.peek()) {
                    sim.input(part.id, channelInput(control.channel, on ? 1 : 0));
                    live.value = new Map(live.peek()).set(key, on ? 1 : 0);
                  } else editor.setProp(part.id, control.prop, on);
                }}
              />
              <span class="field-label">{control.label}</span>
            </label>
          );
        }
        if (control.kind === 'select') {
          const key = `${part.id}:${control.prop}`;
          const initial = String(part.props[control.prop] ?? defaults[control.prop] ?? control.options[0]);
          const liveIndex = running ? values.get(key) : undefined;
          const current = liveIndex === undefined ? initial : (control.options[liveIndex] ?? initial);
          return (
            <label key={control.label} class="field">
              <span class="field-label">{control.label}</span>
              <select
                value={current}
                onChange={(event) => {
                  const name = (event.target as HTMLSelectElement).value;
                  const index = control.options.indexOf(name);
                  if (simRunning.peek()) {
                    sim.input(part.id, channelInput(control.channel, index));
                    live.value = new Map(live.peek()).set(key, index);
                  } else editor.setProp(part.id, control.prop, name);
                }}
              >
                {control.options.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        const toggleProp = control.toggleProp;
        const disabled = !running && toggleProp === undefined;
        return (
          <button
            key={control.label}
            type="button"
            class="tool-button"
            disabled={disabled}
            title={disabled ? 'Run the bench to use this' : undefined}
            onClick={() => {
              if (simRunning.peek()) sim.input(part.id, control.input);
              else if (toggleProp !== undefined) editor.setProp(part.id, toggleProp, (part.props[toggleProp] ?? defaults[toggleProp]) !== true);
            }}
          >
            {control.label}
          </button>
        );
      })}
    </div>
  );
}
