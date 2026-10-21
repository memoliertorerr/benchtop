/**
 * The microphone (BT41): the computer's microphone feeds one microphone part while the bench
 * runs. Capture starts only when the user clicks the part's "Use microphone" control; the
 * browser asks for permission then. Audio goes through the `benchtop-mic` AudioWorklet
 * (mic-worklet.ts: 16 kHz, 512-sample blocks) straight to the simulation worker as `audioIn`;
 * nothing is recorded, stored or uploaded. Pausing, stopping, reloading or leaving the page
 * stops the tracks, so the browser's microphone indicator goes off. A denied or missing device
 * is a note in the Problems tab, never an exception.
 */

import { effect, signal } from '@preact/signals';
import { sim, simRunning } from '../../sim/host.ts';
import { ensureAudioContext } from '../audio.ts';
import micWorkletUrl from './mic-worklet.ts?worker&url';

export type MicState = 'off' | 'starting' | 'on';

/** Which microphone part listens, and how far it got. */
export const micState = signal<{ part: string | null; state: MicState }>({ part: null, state: 'off' });
/** Why the microphone couldn't start (for the Problems tab), until the next attempt. */
export const micNotes = signal<readonly string[]>([]);

let capture: { stream: MediaStream; source: MediaStreamAudioSourceNode; node: AudioWorkletNode; sink: GainNode } | null = null;
let moduleLoad: Promise<void> | null = null;

function explain(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access was denied. Allow it in the browser’s site settings, then click “Use microphone” again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found on this computer.';
  if (name === 'NotReadableError') return 'The microphone is in use by another app or couldn’t be opened.';
  return `The microphone couldn’t start: ${error instanceof Error ? error.message : String(error)}`;
}

/** Starts feeding `part` from the computer's microphone (call from a click). */
export async function startMic(part: string): Promise<void> {
  stopMic();
  micNotes.value = [];
  if (!simRunning.peek()) return;
  micState.value = { part, state: 'starting' };
  if (navigator.mediaDevices?.getUserMedia === undefined) {
    micNotes.value = ['This page can’t use a microphone here: browsers allow it only on https or localhost.'];
    micState.value = { part: null, state: 'off' };
    return;
  }
  // Created inside the click, before anything awaits, so autoplay rules let it run.
  const context = ensureAudioContext();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
  } catch (error) {
    micNotes.value = [explain(error)];
    micState.value = { part: null, state: 'off' };
    return;
  }
  // Paused or switched to another part while the permission prompt was up.
  if (!simRunning.peek() || micState.peek().part !== part) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  try {
    moduleLoad ??= context.audioWorklet.addModule(micWorkletUrl);
    await moduleLoad;
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'benchtop-mic', { numberOfInputs: 1, numberOfOutputs: 1 });
    // A silent path to the output keeps the node processing; nothing is heard.
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(node).connect(sink).connect(context.destination);
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (simRunning.peek()) sim.audioIn(part, event.data);
    };
    capture = { stream, source, node, sink };
    micState.value = { part, state: 'on' };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    micNotes.value = [explain(error)];
    micState.value = { part: null, state: 'off' };
  }
}

/** Stops capturing and releases the device. */
export function stopMic(): void {
  if (capture !== null) {
    for (const track of capture.stream.getTracks()) track.stop();
    capture.node.port.onmessage = null;
    capture.source.disconnect();
    capture.node.disconnect();
    capture.sink.disconnect();
    capture = null;
  }
  if (micState.peek().state !== 'off') micState.value = { part: null, state: 'off' };
}

effect(() => {
  if (!simRunning.value) stopMic();
});
window.addEventListener('pagehide', stopMic);
