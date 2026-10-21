/**
 * Microphone audio to 16 kHz (BT41): the capture rate (48 or 44.1 kHz) down to the microphone
 * part's rate by averaging each output period's input (a box filter; enough for speech and
 * whistles into an ADC), emitting fixed-size blocks. Pure and allocation-free per sample, for
 * the capture AudioWorklet (mic-worklet.ts) and Node tests.
 */

export class Downsampler {
  private readonly ratio: number;
  private readonly block: Float32Array;
  private fill = 0;
  /** Input samples left in the current output period, and their running sum and count. */
  private left: number;
  private sum = 0;
  private count = 0;
  private readonly emit: (block: Float32Array) => void;

  /** `emit` gets each full block; it must copy or transfer it before the next one starts. */
  constructor(inRate: number, outRate: number, blockSize: number, emit: (block: Float32Array) => void) {
    this.ratio = inRate / outRate;
    this.left = this.ratio;
    this.block = new Float32Array(blockSize);
    this.emit = emit;
  }

  push(input: ArrayLike<number>): void {
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.left -= 1;
      if (this.left > 0) continue;
      this.block[this.fill++] = this.sum / this.count;
      this.sum = 0;
      this.count = 0;
      this.left += this.ratio;
      if (this.fill === this.block.length) {
        this.emit(this.block);
        this.fill = 0;
      }
    }
  }
}
