/**
 * The microphone's capture AudioWorklet (BT41): `benchtop-mic` downsamples its input to 16 kHz
 * and posts blocks of 512 samples (32 ms) to the main thread, which forwards them to the
 * simulation worker. Nothing is kept: each block is transferred and forgotten.
 */

import { Downsampler } from './downsampler.ts';
import { scope, type WorkletProcessor } from './worklet-scope.ts';

const MIC_RATE = 16_000;
const BLOCK = 512;

class MicProcessor extends scope.AudioWorkletProcessor implements WorkletProcessor {
  private readonly down: Downsampler;

  constructor() {
    super();
    this.down = new Downsampler(scope.sampleRate, MIC_RATE, BLOCK, (block) => {
      const copy = block.slice();
      this.port.postMessage(copy, [copy.buffer]);
    });
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel !== undefined) this.down.push(channel);
    return true;
  }
}

scope.registerProcessor('benchtop-mic', MicProcessor);
