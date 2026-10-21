/**
 * Speaker sound (BT41): each speaker part's stream (its visual state's `audio` blocks, 22,050 Hz
 * of simulated time) goes to its own `benchtop-speaker` AudioWorklet node (speaker-worklet.ts),
 * which buffers ~100 ms and resamples to the AudioContext's rate. Muted by default like the
 * buzzers (ui/audio.ts); nothing is sent to a node while muted. Blocks whose start times don't
 * follow on (the speaker went idle in between) end the previous run first, and so does a frame
 * with `playing` false. Underruns — the bench running below real time — show "audio behind" in
 * the status bar for 1.5 s after the last one. Pausing or reloading the bench removes the nodes.
 */

import { effect, signal } from '@preact/signals';
import { SPEAKER_BLOCK, SPEAKER_RATE } from '@benchtop/parts';
import { onVisuals, simLoaded, simRunning } from '../../sim/host.ts';
import { currentAudioContext, muted } from '../audio.ts';
import speakerWorkletUrl from './speaker-worklet.ts?worker&url';

/** The stream played late recently: some speaker's buffer ran dry. */
export const audioBehind = signal(false);

const PERIOD_NS = 1e9 / SPEAKER_RATE;
const BEHIND_MS = 1500;

interface Voice {
  node: AudioWorkletNode | null;
  /** Messages waiting for the node (the worklet module loads asynchronously). */
  queue: (Float32Array | 'end')[];
  /** Start time (ns) the next block would have if the run goes on. */
  next: number;
  underruns: number;
}

const voices = new Map<string, Voice>();
let moduleLoad: Promise<void> | null = null;
let behindTimer = 0;

function send(voice: Voice, message: Float32Array | 'end'): void {
  if (voice.node === null) voice.queue.push(message);
  else if (message === 'end') voice.node.port.postMessage('end');
  else voice.node.port.postMessage(message, [message.buffer]);
}

function voiceFor(id: string, context: AudioContext): Voice {
  const existing = voices.get(id);
  if (existing !== undefined) return existing;
  const voice: Voice = { node: null, queue: [], next: Number.NaN, underruns: 0 };
  voices.set(id, voice);
  moduleLoad ??= context.audioWorklet.addModule(speakerWorkletUrl);
  moduleLoad
    .then(() => {
      if (voices.get(id) !== voice) return;
      const node = new AudioWorkletNode(context, 'benchtop-speaker', { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { rate: SPEAKER_RATE } });
      node.port.onmessage = (event: MessageEvent<{ underruns: number }>) => {
        if (event.data.underruns <= voice.underruns) return;
        voice.underruns = event.data.underruns;
        audioBehind.value = true;
        clearTimeout(behindTimer);
        behindTimer = window.setTimeout(() => (audioBehind.value = false), BEHIND_MS);
      };
      node.connect(context.destination);
      voice.node = node;
      for (const message of voice.queue.splice(0)) send(voice, message);
    })
    .catch((error: unknown) => console.warn('benchtop: speaker audio unavailable', error));
  return voice;
}

function removeAll(): void {
  for (const voice of voices.values()) {
    voice.node?.port.postMessage('clear');
    voice.node?.disconnect();
  }
  voices.clear();
  audioBehind.value = false;
}

onVisuals((parts) => {
  for (const [id, visual] of parts) {
    if (!Array.isArray(visual.audio)) continue;
    const context = currentAudioContext();
    if (context === null || muted.peek()) continue;
    const samples = visual.audio as readonly number[];
    const starts = Array.isArray(visual.audioT) ? (visual.audioT as readonly number[]) : [];
    if (samples.length === 0 && visual.playing !== false) continue;
    const voice = voiceFor(id, context);
    for (let b = 0; b < starts.length; b++) {
      if (!Number.isNaN(voice.next) && Math.abs(starts[b] - voice.next) > PERIOD_NS) send(voice, 'end');
      send(voice, Float32Array.from(samples.slice(b * SPEAKER_BLOCK, (b + 1) * SPEAKER_BLOCK)));
      voice.next = starts[b] + SPEAKER_BLOCK * PERIOD_NS;
    }
    if (visual.playing === false) {
      send(voice, 'end');
      voice.next = Number.NaN;
    }
  }
});

effect(() => {
  if (!simRunning.value || !simLoaded.value || muted.value) removeAll();
});
