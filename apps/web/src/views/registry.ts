/**
 * Part views: how a part type is drawn. A view only renders — props from the document and
 * visual state from simulation frames; it never computes behavior.
 */

import type { PartDefinition, PartInput, PartProps, VisualState } from '@benchtop/core';
import { a4988View } from './a4988.ts';
import { microphoneView, speakerView } from './audio-parts.ts';
import { breadboardView } from './breadboard.ts';
import { ENVIRONMENT_VIEW_TYPES, environmentView } from './environment.ts';
import { fallbackView } from './fallback.ts';
import { POWER_VIEW_TYPES, powerView } from './power.ts';
import { raspberryPiPicoView } from './raspberry-pi-pico.ts';
import { stepper28byj48View } from './stepper-28byj48.ts';
import { hasWokwiView, wokwiView } from './wokwi.ts';

export interface ViewFactory {
  /** Builds the element (loading its code on first use). Sized in mm by its own SVG. */
  create(def: PartDefinition, props: PartProps): Promise<HTMLElement>;
  /** Applies document props (color, resistance, …). */
  setProps(el: HTMLElement, props: PartProps): void;
  /** Applies simulation visual state (brightness, pressed, …). */
  update(el: HTMLElement, visual: VisualState): void;
  /**
   * Forwards the element's own interactions (a press, a knob turn) as part input. Only
   * interactive views have it; their elements take the pointer while the bench runs.
   * Returns the unbind function.
   */
  bindInput?(el: HTMLElement, send: (input: PartInput) => void): () => void;
}

export function viewFor(type: string): ViewFactory {
  if (type.startsWith('breadboard')) return breadboardView;
  if (type === 'stepper-28byj48') return stepper28byj48View;
  if (type === 'a4988') return a4988View;
  if (type === 'raspberry-pi-pico' || type === 'raspberry-pi-pico-2') return raspberryPiPicoView;
  if (type === 'speaker') return speakerView;
  if (type === 'microphone') return microphoneView;
  if (ENVIRONMENT_VIEW_TYPES.has(type)) return environmentView;
  if (POWER_VIEW_TYPES.has(type)) return powerView;
  if (hasWokwiView(type)) return wokwiView;
  return fallbackView;
}
