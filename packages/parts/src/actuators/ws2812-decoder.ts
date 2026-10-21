/**
 * WS2812B decoding from DIN edge timestamps (WorldSemi datasheet). A high shorter than 0.625 µs
 * is a 0, otherwise a 1; a high outside 0.2–1.0 µs is a timing error (counted). 24 bits per
 * pixel, GRB, MSB first. A low longer than 50 µs latches the frame and resets the bit counter
 * (newer WS2812B parts need 280 µs; decided 50 µs). Once a part has consumed its own
 * `length`·24 bits, further DIN edges are passed to DOUT until the next latch, so chained parts
 * see identical timestamps. Pure and allocation-free: the part feeds edges and checks latches.
 */

export const LATCH_NS = 50_000;
const ONE_MIN_NS = 625;
const VALID_MIN_NS = 200;
const VALID_MAX_NS = 1000;

export class Ws2812Decoder {
  readonly length: number;
  /** Latched colors, 0xRRGGBB, chain order. */
  readonly pixels: Uint32Array;
  private readonly pending: Uint32Array;
  /** Bits of the frame in progress (this part's own; passed-on bits not counted). */
  bits = 0;
  errors = 0;
  /** Stats of the last latched frame. */
  frameBits = 0;
  frameErrors = 0;
  t0hMin = 0;
  t0hMax = 0;
  t1hMin = 0;
  t1hMax = 0;
  private stats0Min = Number.POSITIVE_INFINITY;
  private stats0Max = 0;
  private stats1Min = Number.POSITIVE_INFINITY;
  private stats1Max = 0;
  private riseAt = -1;
  private lastFall = Number.NEGATIVE_INFINITY;
  private accumulator = 0;
  /** True while this part's share of the frame is complete: edges go to DOUT. */
  passing = false;
  /** Counts latches, so a caller can tell that `rise` latched a frame. */
  latches = 0;

  constructor(length: number) {
    this.length = length;
    this.pixels = new Uint32Array(length);
    this.pending = new Uint32Array(length);
  }

  /**
   * DIN rose at `now`. Returns true when the edge belongs on DOUT (this part has its bits). A
   * gap > 50 µs since the last fall latches first (`latched` tells the caller to redraw).
   */
  rise(now: number): boolean {
    if (now - this.lastFall > LATCH_NS) this.latch();
    if (this.passing) return true;
    this.riseAt = now;
    return false;
  }

  /** DIN fell at `now`. Returns true when the edge belongs on DOUT. */
  fall(now: number): boolean {
    this.lastFall = now;
    if (this.passing) return true;
    if (this.riseAt < 0) return false;
    const high = now - this.riseAt;
    this.riseAt = -1;
    const one = high >= ONE_MIN_NS;
    if (high < VALID_MIN_NS || high > VALID_MAX_NS) this.errors++;
    if (one) {
      if (high < this.stats1Min) this.stats1Min = high;
      if (high > this.stats1Max) this.stats1Max = high;
    } else {
      if (high < this.stats0Min) this.stats0Min = high;
      if (high > this.stats0Max) this.stats0Max = high;
    }
    this.accumulator = ((this.accumulator << 1) | (one ? 1 : 0)) & 0xffffff;
    this.bits++;
    if (this.bits % 24 === 0) {
      const grb = this.accumulator;
      this.pending[this.bits / 24 - 1] = ((grb >> 8) & 0xff) << 16 | ((grb >> 16) & 0xff) << 8 | (grb & 0xff);
      if (this.bits === this.length * 24) this.passing = true;
    }
    return false;
  }

  /** True when the line has been low for > 50 µs at `now` with a frame in progress. */
  due(now: number): boolean {
    return (this.bits > 0 || this.passing) && this.riseAt < 0 && now - this.lastFall > LATCH_NS;
  }

  /** When `due` can next become true. */
  get latchAt(): number {
    return this.lastFall + LATCH_NS + 1;
  }

  /** Ends the frame: complete pixels take their new colors. Returns true if anything latched. */
  latch(): boolean {
    if (this.bits === 0 && !this.passing) return false;
    const complete = Math.floor(this.bits / 24);
    for (let i = 0; i < complete; i++) this.pixels[i] = this.pending[i];
    this.frameBits = this.bits;
    this.frameErrors = this.errors;
    this.t0hMin = this.stats0Min === Number.POSITIVE_INFINITY ? 0 : this.stats0Min;
    this.t0hMax = this.stats0Max;
    this.t1hMin = this.stats1Min === Number.POSITIVE_INFINITY ? 0 : this.stats1Min;
    this.t1hMax = this.stats1Max;
    this.bits = 0;
    this.errors = 0;
    this.stats0Min = Number.POSITIVE_INFINITY;
    this.stats0Max = 0;
    this.stats1Min = Number.POSITIVE_INFINITY;
    this.stats1Max = 0;
    this.passing = false;
    this.riseAt = -1;
    this.latches++;
    return true;
  }

  reset(): void {
    this.pixels.fill(0);
    this.pending.fill(0);
    this.bits = 0;
    this.errors = 0;
    this.frameBits = 0;
    this.frameErrors = 0;
    this.passing = false;
    this.riseAt = -1;
    this.lastFall = Number.NEGATIVE_INFINITY;
  }
}

/** Row and column of chain index `i` in a matrix `cols` wide (serpentine: odd rows reversed). */
export function matrixPosition(i: number, cols: number, serpentine: boolean): { row: number; col: number } {
  const row = Math.floor(i / cols);
  const col = i % cols;
  return { row, col: serpentine && row % 2 === 1 ? cols - 1 - col : col };
}
