import type { PartInstance } from '@benchtop/core';
import { channelInput } from '@benchtop/parts';
import { signal } from '@preact/signals';
import { editor } from '../editor/app-store.ts';
import { sim, simRunning } from '../sim/host.ts';
import { CONTROLS, roundToStep, type SliderControl, sliderToValue, valueToSlider } from '../views/controls.ts';
import { micState, startMic, stopMic } from './audio/mic.ts';

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

/** The Inspector's live controls for a part (light, temperature, motion …), if it has any. */
export function PartControls({ part, defaults }: { part: PartInstance; defaults: Record<string, unknown> }) {
  if (part.type === 'microphone') return <MicControl part={part} />;
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
