import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './manifest.ts';
import { type ExampleRun, runExample, tftPixels } from './run.test-helper.ts';

// BT43: every ESP32 and two-board example runs 2 s of simulated time in Node (the real ROM, a
// direct boot) and does what its card says. Uno examples: examples-run-uno.test.ts.

const brightness = (r: ExampleRun, part: string): number => (r.visual(part)?.brightness as number | undefined) ?? 0;
const audioSamples = (r: ExampleRun, part: string): number => r.history(part).reduce((n, { visual }) => n + ((visual.audio as number[] | undefined)?.length ?? 0), 0);

export const ESP32_CHECKS: Record<string, (r: ExampleRun) => void> = {
  'esp32-blink'(r) {
    r.runTo(2000);
    let flips = 0;
    let last: boolean | undefined;
    for (const { visual } of r.history('led1')) {
      const on = (visual.brightness as number) > 0.3;
      if (last !== undefined && on !== last) flips++;
      last = on;
    }
    expect(flips).toBeGreaterThanOrEqual(2);
  },
  'esp32-serial-hello'(r) {
    r.runTo(2000);
    expect(r.serial('esp')).toContain('hello from esp32');
  },
  'esp32-button'(r) {
    r.runTo(1000);
    expect(r.lit('led1')).toBe(false);
    r.input('btn1', { kind: 'press' });
    r.runTo(1300);
    expect(r.lit('led1')).toBe(true);
    r.input('btn1', { kind: 'release' });
    r.runTo(2000);
    expect(r.lit('led1')).toBe(false);
  },
  'esp32-pwm-fader'(r) {
    r.runTo(1000);
    const middle = brightness(r, 'led1');
    r.input('pot', { kind: 'value', value: 0.1 });
    r.runTo(1500);
    const low = brightness(r, 'led1');
    r.input('pot', { kind: 'value', value: 0.9 });
    r.runTo(2000);
    const high = brightness(r, 'led1');
    expect(low).toBeLessThan(middle);
    expect(high).toBeGreaterThan(middle);
  },
  'esp32-neopixel'(r) {
    r.runTo(2000);
    expect(r.history('strip').some(({ visual }) => ((visual.pixels as number[])[0] ?? 0) !== 0)).toBe(true);
  },
  'esp32-rainbow-ring'(r) {
    r.runTo(1200);
    const first = [...((r.visual('ring')?.pixels ?? []) as number[])];
    r.runTo(2000);
    const later = (r.visual('ring')?.pixels ?? []) as number[];
    expect(first.filter((p) => p !== 0).length).toBe(16);
    expect(later).not.toEqual(first); // the rainbow turned
  },
  'esp32-oled-clock'(r) {
    r.runTo(2000);
    expect(r.serial('esp')).toContain('2026-01-01 00:00:01');
    expect(((r.visual('oled')?.fb ?? []) as number[]).some((v) => v !== 0)).toBe(true);
  },
  'esp32-tft'(r) {
    r.runTo(1000);
    expect(r.serial('esp')).toContain('drawn');
    expect(tftPixels(r, 'tft', [[15, 15], [140, 30], [20, 80], [10, 130], [5, 300]])).toEqual([0xf800, 0x07e0, 0x001f, 0xffff, 0]);
  },
  'esp32-dac-sine'(r) {
    r.runTo(2000);
    expect(audioSamples(r, 'spk1')).toBeGreaterThanOrEqual(20 * 1024);
  },
  'esp32-mic-level'(r) {
    r.listen('mic1', 440, 2000);
    const readings = r.serial('esp').split('\r\n').filter(Boolean).map(Number);
    expect(readings.length).toBeGreaterThanOrEqual(3);
    for (const hz of readings.slice(1)) expect(Math.abs(hz - 440)).toBeLessThanOrEqual(10);
  },
  'esp32-i2c-scan'(r) {
    r.runTo(2000);
    expect(r.serial('esp')).toContain('found 0x3C');
    expect(r.serial('esp')).toContain('found 0x68');
  },
  'uart-chat'(r) {
    r.runTo(2000);
    expect(r.serial('esp')).toContain('ping 1 -> pong 1');
    expect(r.serial('uno')).toContain('got pong 1');
  },
  'uart-relay'(r) {
    r.runTo(2000);
    expect(r.serial('esp')).toContain('ping');
  },
};

describe('every ESP32 and two-board example runs as described (BT43)', () => {
  const withEsp32 = EXAMPLES.filter((e) => Object.values(e.boards).some((b) => 'firmware' in b && b.firmware.startsWith('esp32/')));
  it('has a check for each', () => {
    expect(withEsp32.map((e) => e.id).filter((id) => ESP32_CHECKS[id] === undefined)).toEqual([]);
  });
  for (const example of withEsp32) {
    it(
      example.id,
      () => {
        const check = ESP32_CHECKS[example.id];
        if (check === undefined) throw new Error(`no check for ${example.id}`);
        check(runExample(example));
      },
      60_000,
    );
  }
});
