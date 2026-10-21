import { describe, expect, it } from 'vitest';
import { RP2040_CLOCK_HZ } from './rp2040-mcu.ts';
import { bootPico, runMs } from './rp2040.test-helper.ts';

// BT62: PIO on real arduino-pico 6.2.0 firmware — the adapter steps the state machines in
// simulated time (clock dividers and delays included) instead of rp2040js's setTimeout loop.

/** Rising and falling edge times (µs) of a pin's output, whatever drives it. */
function edges(mcu: ReturnType<typeof bootPico>['mcu'], name: string): { rises: number[]; falls: number[] } {
  const pin = mcu.pins.get(name);
  if (pin === undefined) throw new Error(`no pin ${name}`);
  const rises: number[] = [];
  const falls: number[] = [];
  let level = -1;
  pin.onOutputChange(() => {
    const now = pin.outputLevel();
    if (now === level) return;
    level = now;
    (now === 1 ? rises : falls).push((mcu.cycles / RP2040_CLOCK_HZ) * 1e6);
  });
  return { rises, falls };
}

describe('RP2040 PIO', () => {
  it('pio-square: PIO1 drives GP3 at 10 kHz ±0.5 % with a 50 % duty', () => {
    const { mcu, serial } = bootPico('pio-square');
    const { rises, falls } = edges(mcu, 'GPIO3');
    runMs(mcu, 1050); // USB serial enumerates after the first line: the second is at 1 s
    expect(mcu.pins.get('GPIO3')?.mode()).toBe('peripheral');
    const window = rises.filter((t) => t > 100_000);
    expect(window.length).toBeGreaterThan(9000);
    const period = (window.at(-1)! - window[0]) / (window.length - 1);
    expect(Math.abs(1e6 / period - 10_000) / 10_000).toBeLessThan(0.005);
    const highs = window.slice(0, -1).map((r) => (falls.find((f) => f > r) as number) - r);
    expect(Math.abs(highs.reduce((a, b) => a + b, 0) / highs.length / period - 0.5)).toBeLessThan(0.01);
    expect(serial[0]).toContain('square on GP3\r\n');
  });

  it('neopixel: the WS2812 program on GP2 sends 0 and 1 bits with their own high times', () => {
    const { mcu, serial } = bootPico('neopixel');
    const { rises, falls } = edges(mcu, 'GPIO2');
    runMs(mcu, 600);
    expect(serial[0]).toContain('shown 1\r\n'); // "shown 0" goes before USB serial enumerates
    // 800 kHz × 10 PIO cycles: a 0 is high 2 cycles (250 ns), a 1 is high 7 (875 ns), the bit 1.25 µs.
    const highs = rises.slice(0, -1).map((r) => (falls.find((f) => f > r) as number) - r);
    const zeros = highs.filter((h) => h < 0.5);
    const ones = highs.filter((h) => h >= 0.5);
    expect(zeros.length + ones.length).toBeGreaterThanOrEqual(8 * 24);
    for (const h of zeros) expect(Math.abs(h - 0.25)).toBeLessThan(0.01);
    for (const h of ones) expect(Math.abs(h - 0.875)).toBeLessThan(0.01);
    const firstFrame = rises.slice(0, 24 * 8);
    const bits = (firstFrame.at(-1)! - firstFrame[0]) / (firstFrame.length - 1);
    expect(Math.abs(bits - 1.25)).toBeLessThan(0.01);
  });

  it('reports the cost of one running state machine', () => {
    const { mcu } = bootPico('pio-square');
    const start = performance.now();
    runMs(mcu, 500);
    const seconds = (performance.now() - start) / 1000;
    // The core sleeps in delay(); the state machine steps 64 × 10 000 times a simulated second.
    console.info(`rp2040 pio-square: 0.5 s simulated in ${seconds.toFixed(2)} s (${((mcu.cycles / RP2040_CLOCK_HZ / seconds) * 100).toFixed(0)} % of real time)`);
    expect(mcu.cycles).toBeGreaterThanOrEqual(RP2040_CLOCK_HZ / 2);
  }, 60_000);
});
