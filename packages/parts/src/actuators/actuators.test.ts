import { describe, expect, it } from 'vitest';
import { servoAngle } from './servo.ts';
import { halfStepDelta, StepTracker } from './stepper.ts';
import { LATCH_NS, matrixPosition, Ws2812Decoder } from './ws2812-decoder.ts';

/** Feeds `bytes` as WS2812 bits from `t` (ns): 1.25 µs per bit, highs of 375 / 750 ns. */
function send(decoder: Ws2812Decoder, bytes: number[], t: number): number {
  let now = t;
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      const one = (byte >> bit) & 1;
      decoder.rise(now);
      decoder.fall(now + (one ? 750 : 375));
      now += 1250;
    }
  }
  return now;
}

describe('WS2812 decoding', () => {
  it('reads GRB bytes MSB first and latches after a gap over 50 µs, not 20 µs', () => {
    const d = new Ws2812Decoder(3);
    let t = send(d, [0x00, 0xff, 0x00], 0); // pixel 0: red
    t = send(d, [0x80, 0x01, 0x7f], t + 20_000); // a 20 µs gap: same frame, pixel 1
    expect(d.latches).toBe(0);
    expect(d.bits).toBe(48);
    expect(d.due(t + 20_000)).toBe(false);
    expect(d.due(t + LATCH_NS + 2000)).toBe(true);
    send(d, [0x00, 0x00, 0xff], t + 60_000); // a 60 µs gap: latch, then a new frame
    expect(d.latches).toBe(1);
    expect([...d.pixels]).toEqual([0xff0000, 0x01807f, 0]);
    expect(d.frameBits).toBe(48);
    expect(d.frameErrors).toBe(0);
    expect([d.t0hMin, d.t0hMax, d.t1hMin, d.t1hMax]).toEqual([375, 375, 750, 750]);
  });

  it('passes edges on once its own pixels are full, until the latch', () => {
    const d = new Ws2812Decoder(1);
    send(d, [1, 2, 3], 0);
    expect(d.passing).toBe(true);
    expect(d.rise(30_000)).toBe(true);
    expect(d.fall(30_400)).toBe(true);
    expect(d.rise(100_000)).toBe(false); // > 50 µs later: latched, decoding again
    expect(d.pixels[0]).toBe(0x020103);
  });

  it('counts highs outside 0.2–1.0 µs as errors', () => {
    const d = new Ws2812Decoder(1);
    d.rise(0);
    d.fall(150);
    d.rise(2000);
    d.fall(3200);
    d.latch();
    expect(d.frameErrors).toBe(2);
  });

  it('maps a matrix chain index to row and column, serpentine or not', () => {
    expect(matrixPosition(0, 8, false)).toEqual({ row: 0, col: 0 });
    expect(matrixPosition(9, 8, false)).toEqual({ row: 1, col: 1 });
    expect(matrixPosition(8, 8, true)).toEqual({ row: 1, col: 7 });
    expect(matrixPosition(15, 8, true)).toEqual({ row: 1, col: 0 });
    expect(matrixPosition(16, 8, true)).toEqual({ row: 2, col: 0 });
  });
});

describe('servo and stepper decoding', () => {
  it('maps Servo.h pulse widths to angles', () => {
    expect(servoAngle(544, 544, 2400)).toBe(0);
    expect(servoAngle(1472, 544, 2400)).toBe(90);
    expect(servoAngle(2400, 544, 2400)).toBe(180);
    expect(servoAngle(3000, 544, 2400)).toBe(180);
  });

  it('moves by the shortest half-step distance; 4 is ambiguous', () => {
    expect(halfStepDelta(0, 1)).toBe(1);
    expect(halfStepDelta(7, 1)).toBe(2);
    expect(halfStepDelta(1, 7)).toBe(-2);
    expect(halfStepDelta(3, 7)).toBe(4);
  });

  it('takes the first state as the reference and merges same-instant changes', () => {
    const t = new StepTracker();
    expect(t.update(1, 0)).toBe('none');
    expect(t.update(2, 10)).toBe('moved');
    expect(t.update(3, 10)).toBe('moved'); // same instant: replaces the 2, a +2 from 1
    expect(t.halfSteps).toBe(2);
    expect(t.update(7, 20)).toBe('ambiguous');
    expect(t.halfSteps).toBe(2);
    expect(t.update(-1, 30)).toBe('none');
    expect(t.ambiguous).toBe(1);
  });
});
