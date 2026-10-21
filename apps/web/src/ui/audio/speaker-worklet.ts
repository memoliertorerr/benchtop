/**
 * The speakers' AudioWorklet (BT41): one `benchtop-speaker` processor per speaker part, playing
 * its stream through a StreamPlayer at the AudioContext's rate. Messages in: a Float32Array (a
 * run of the stream's samples, volts), `'end'` (the speaker went idle), `'clear'` (drop the
 * buffer). Out, twice a second when they change: `{ underruns, dropped }`.
 */

import { StreamPlayer } from './stream-player.ts';
import { scope, type WorkletProcessor } from './worklet-scope.ts';

class SpeakerProcessor extends scope.AudioWorkletProcessor implements WorkletProcessor {
  private readonly player: StreamPlayer;
  private frames = 0;
  private reported = '';

  constructor(options: { processorOptions?: unknown }) {
    super();
    const rate = (options.processorOptions as { rate?: number } | undefined)?.rate ?? 22_050;
    this.player = new StreamPlayer(rate, scope.sampleRate);
    this.port.onmessage = (event: MessageEvent<Float32Array | 'end' | 'clear'>) => {
      if (event.data === 'end') this.player.end();
      else if (event.data === 'clear') this.player.clear();
      else this.player.push(event.data);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const first = channels?.[0];
    if (first === undefined) return true;
    this.player.render(first);
    for (let c = 1; c < channels.length; c++) channels[c].set(first);
    this.frames += first.length;
    if (this.frames >= scope.sampleRate / 2) {
      this.frames = 0;
      const now = `${this.player.underruns}/${this.player.dropped}`;
      if (now !== this.reported) {
        this.reported = now;
        this.port.postMessage({ underruns: this.player.underruns, dropped: this.player.dropped });
      }
    }
    return true;
  }
}

scope.registerProcessor('benchtop-speaker', SpeakerProcessor);
