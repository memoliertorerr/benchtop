/**
 * Buzzer sound through Web Audio, on the UI thread (never in the worker), and the app's one
 * AudioContext (speakers and the microphone use it too: ui/audio/). Muted by default; the
 * AudioContext is created on the first unmute or "Use microphone" click (autoplay policy). Each sounding
 * buzzer gets one square OscillatorNode through a GainNode (0.05); frequency changes glide with
 * setTargetAtTime(f, now, 0.005); a buzzer at frequency 0 is stopped. Frames carry the
 * buzzer's visual state (`sounding`, `frequency`); pausing or reloading the bench silences all.
 */

import { effect, signal } from '@preact/signals';
import { onVisuals, simLoaded, simRunning } from '../sim/host.ts';

export const muted = signal(true);

let context: AudioContext | null = null;

/** The AudioContext, created (and resumed) on first use: call it from a click. */
export function ensureAudioContext(): AudioContext {
  context ??= new AudioContext();
  void context.resume();
  return context;
}

/** The AudioContext if one exists (nothing plays before the first click). */
export function currentAudioContext(): AudioContext | null {
  return context;
}
const voices = new Map<string, { osc: OscillatorNode; gain: GainNode }>();
/** The latest frequency per buzzer, kept while muted so unmuting picks up at once. */
const playing = new Map<string, number>();

function stopVoice(id: string): void {
  const voice = voices.get(id);
  if (voice === undefined) return;
  voices.delete(id);
  voice.osc.stop();
  voice.osc.disconnect();
  voice.gain.disconnect();
}

function sound(id: string, frequency: number): void {
  if (context === null || muted.peek() || frequency <= 0) {
    stopVoice(id);
    return;
  }
  const existing = voices.get(id);
  if (existing !== undefined) {
    existing.osc.frequency.setTargetAtTime(frequency, context.currentTime, 0.005);
    return;
  }
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = 'square';
  osc.frequency.value = frequency;
  gain.gain.value = 0.05;
  osc.connect(gain).connect(context.destination);
  osc.start();
  voices.set(id, { osc, gain });
}

function silenceAll(): void {
  for (const id of [...voices.keys()]) stopVoice(id);
}

/** The toolbar's speaker button. */
export function toggleMute(): void {
  const unmute = muted.peek();
  muted.value = !unmute;
  if (unmute) {
    ensureAudioContext();
    for (const [id, frequency] of playing) sound(id, frequency);
  } else {
    silenceAll();
  }
}

onVisuals((parts) => {
  for (const [id, visual] of parts) {
    if (typeof visual.sounding !== 'boolean') continue;
    const frequency = visual.sounding && typeof visual.frequency === 'number' ? visual.frequency : 0;
    if (frequency > 0) playing.set(id, frequency);
    else playing.delete(id);
    sound(id, frequency);
  }
});

effect(() => {
  if (!simRunning.value || !simLoaded.value) {
    playing.clear();
    silenceAll();
  }
});
