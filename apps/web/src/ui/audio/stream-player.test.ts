import { describe, expect, it } from 'vitest';
import { Downsampler } from './downsampler.ts';
import { StreamPlayer } from './stream-player.ts';

const IN = 22_050;
const OUT = 48_000;

/** `seconds` of a `hz` sine around `dc` volts, amplitude `amp`, from sample `from`. */
function tone(seconds: number, hz: number, rate = IN, dc = 2.5, amp = 1, from = 0): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => dc + amp * Math.sin((2 * Math.PI * hz * (from + i)) / rate));
}

/** Renders `seconds` of output in 128-frame quanta, as an AudioWorklet does. */
function render(player: StreamPlayer, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * OUT));
  const quantum = new Float32Array(128);
  for (let at = 0; at < out.length; at += 128) {
    player.render(quantum);
    out.set(quantum.subarray(0, Math.min(128, out.length - at)), at);
  }
  return out;
}

/** Rising zero crossings per second over `x` (rate `rate`). */
function frequency(x: Float32Array, rate: number): number {
  let crossings = 0;
  let first = -1;
  let last = -1;
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      crossings++;
      if (first < 0) first = i;
      last = i;
    }
  }
  return ((crossings - 1) * rate) / (last - first);
}

describe('StreamPlayer (speaker playback)', () => {
  it('buffers ~100 ms, then plays the stream resampled, without its DC offset', () => {
    const player = new StreamPlayer(IN, OUT);
    player.push(tone(0.3, 440));
    const out = render(player, 0.25);
    // Plays from the first quantum (0.3 s is past the 100 ms target).
    const steady = out.subarray(Math.round(0.05 * OUT));
    expect(Math.abs(frequency(steady, OUT) - 440)).toBeLessThan(1);
    const mean = steady.reduce((a, b) => a + b, 0) / steady.length;
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(Math.max(...steady)).toBeCloseTo(0.06, 2); // 1 V of swing at the gain
    expect(player.underruns).toBe(0);
  });

  it('waits for the jitter buffer, and counts an underrun when the stream runs dry mid-run', () => {
    const player = new StreamPlayer(IN, OUT);
    player.push(tone(0.05, 440));
    expect(render(player, 0.02).every((v) => v === 0)).toBe(true); // 50 ms < 100 ms: still buffering
    player.push(tone(0.1, 440, IN, 2.5, 1, 0.05 * IN));
    render(player, 0.3); // 150 ms buffered, 300 ms asked for
    expect(player.underruns).toBe(1);
  });

  it('plays out an ended run without counting an underrun', () => {
    const player = new StreamPlayer(IN, OUT);
    player.push(tone(0.06, 440));
    player.end();
    const out = render(player, 0.2);
    expect(out.some((v) => v !== 0)).toBe(true); // the short tail still plays
    expect(player.underruns).toBe(0);
  });

  it('drops the oldest input when more than 400 ms is waiting (the bench running ahead)', () => {
    const player = new StreamPlayer(IN, OUT);
    player.push(tone(1, 440));
    expect(player.buffered).toBe(Math.round(0.1 * IN));
    expect(player.dropped).toBe(IN - Math.round(0.1 * IN));
  });

  it('clear() empties the buffer at once', () => {
    const player = new StreamPlayer(IN, OUT);
    player.push(tone(0.3, 440));
    player.clear();
    expect(render(player, 0.1).every((v) => v === 0)).toBe(true);
    expect(player.underruns).toBe(0);
  });
});

describe('Downsampler (microphone capture)', () => {
  for (const rate of [48_000, 44_100]) {
    it(`brings ${rate} Hz down to 16 kHz blocks of 512, keeping a 440 Hz tone`, () => {
      const blocks: Float32Array[] = [];
      const down = new Downsampler(rate, 16_000, 512, (block) => blocks.push(block.slice()));
      const input = tone(1, 440, rate, 0, 0.5);
      for (let at = 0; at < input.length; at += 128) down.push(input.subarray(at, at + 128));
      expect(blocks.length).toBe(Math.floor(16_000 / 512));
      const out = new Float32Array(blocks.length * 512);
      blocks.forEach((b, i) => out.set(b, i * 512));
      expect(Math.abs(frequency(out, 16_000) - 440)).toBeLessThan(1);
      expect(Math.max(...out)).toBeGreaterThan(0.49);
    });
  }
});
