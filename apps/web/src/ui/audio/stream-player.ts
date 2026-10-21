/**
 * Plays one speaker's stream (BT41): blocks of samples (volts, 22,050 Hz of simulated time) in,
 * audio at the output rate out. Pure and allocation-free after construction, so it runs inside
 * an AudioWorklet (speaker-worklet.ts) and in Node tests.
 *
 * - Input passes a DC blocker (one-pole high-pass at ~20 Hz — a pin's 0/5 V offset is no sound)
 *   and a fixed gain, into a ring of 2 s.
 * - Jitter buffer: a run starts playing once ~100 ms is buffered (`targetSeconds`); output is
 *   linearly resampled from the input rate to the output rate.
 * - Underrun: the buffer runs dry while the stream should be playing (the bench runs below real
 *   time): output silence, count it in `underruns`, and buffer up again.
 * - End of a run: the speaker went idle (`end()`): play out what is buffered, then stay silent
 *   without counting underruns until the next run's first blocks.
 * - Late: more than 400 ms buffered (the bench runs faster than real time) drops the oldest
 *   input down to the target, counted in `dropped`.
 */

const DC_HZ = 20;
const GAIN = 0.06;

export class StreamPlayer {
  underruns = 0;
  dropped = 0;
  private readonly ring: Float32Array;
  private readonly inRate: number;
  private readonly step: number;
  private readonly target: number;
  private readonly maxBuffered: number;
  private readonly dcR: number;
  /** Write index (samples written, absolute) and read position (absolute, fractional). */
  private written = 0;
  private read = 0;
  private playing = false;
  private ended = true;
  private dcX = 0;
  private dcY = 0;

  constructor(inRate: number, outRate: number, targetSeconds = 0.1) {
    this.inRate = inRate;
    this.ring = new Float32Array(Math.ceil(inRate * 2));
    this.step = inRate / outRate;
    this.target = Math.round(inRate * targetSeconds);
    this.maxBuffered = Math.round(inRate * 0.4);
    this.dcR = 1 - (2 * Math.PI * DC_HZ) / inRate;
  }

  /** Samples buffered ahead of the read position. */
  get buffered(): number {
    return this.written - Math.floor(this.read);
  }

  /** Appends a block (volts). A block after `end()` starts a new run. */
  push(samples: ArrayLike<number>): void {
    if (this.ended) {
      this.ended = false;
      this.playing = false;
    }
    const ring = this.ring;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      // y[n] = x[n] − x[n−1] + R·y[n−1]
      this.dcY = x - this.dcX + this.dcR * this.dcY;
      this.dcX = x;
      ring[this.written % ring.length] = this.dcY * GAIN;
      this.written++;
    }
    if (this.buffered > this.maxBuffered) {
      const skip = this.buffered - this.target;
      this.read += skip;
      this.dropped += skip;
    }
  }

  /** The speaker went idle: play out the buffer, then wait for a new run. */
  end(): void {
    this.ended = true;
  }

  /** Drops everything (a pause, a reload). */
  clear(): void {
    this.read = this.written;
    this.playing = false;
    this.ended = true;
  }

  /** Fills `out` at the output rate. */
  render(out: Float32Array): void {
    const ring = this.ring;
    const n = ring.length;
    for (let i = 0; i < out.length; i++) {
      if (!this.playing) {
        if (this.buffered >= this.target || (this.ended && this.buffered > 1)) this.playing = true;
        else {
          out[i] = 0;
          continue;
        }
      }
      const at = Math.floor(this.read);
      if (this.written - at < 2) {
        // Dry: an underrun unless the run ended (idle speakers are silent, not late).
        if (!this.ended) this.underruns++;
        this.playing = false;
        out[i] = 0;
        continue;
      }
      const frac = this.read - at;
      const a = ring[at % n];
      const b = ring[(at + 1) % n];
      out[i] = a + (b - a) * frac;
      this.read += this.step;
    }
  }

  /** Input sample rate. */
  get rate(): number {
    return this.inRate;
  }
}
