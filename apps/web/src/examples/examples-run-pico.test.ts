import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './manifest.ts';
import { type ExampleRun, runExample, tftPixels } from './run.test-helper.ts';

// BT61–BT63: every Raspberry Pi Pico example runs 2 s of simulated time in Node and does what its card
// says (Uno: examples-run-uno.test.ts; ESP32 and two boards: examples-run-esp32.test.ts).

const brightness = (r: ExampleRun, part: string): number => (r.visual(part)?.brightness as number | undefined) ?? 0;

export const PICO_CHECKS: Record<string, (r: ExampleRun) => void> = {
  'pico-blink'(r) {
    r.runTo(2000);
    let flips = 0;
    let last: boolean | undefined;
    for (const { visual } of r.history('pico')) {
      const on = (visual.led as number) > 0.3;
      if (last !== undefined && on !== last) flips++;
      last = on;
    }
    expect(flips).toBeGreaterThanOrEqual(3);
  },
  'pico-potentiometer'(r) {
    r.runTo(500);
    r.input('pot', { kind: 'value', value: 0.75 });
    r.runTo(1000);
    const readings = [...r.serial('pico').matchAll(/adc=(\d+)/g)].map((m) => Number(m[1]));
    expect(Math.abs((readings.at(-1) ?? 0) - 3071)).toBeLessThanOrEqual(8);
  },
  'pico-fade'(r) {
    r.runTo(300);
    const quarter = brightness(r, 'led1');
    r.runTo(700);
    const threeQuarters = brightness(r, 'led1');
    expect(threeQuarters).toBeGreaterThan(quarter);
  },
  'pico-oled'(r) {
    r.runTo(2000);
    expect(r.serial('pico')).toContain('frame 1');
    const fb = (r.visual('oled')?.fb ?? []) as number[];
    expect(fb[0] & 0xff).toBe(0xff); // the filled box's top-left column, page 0
  },
  'pico-tft'(r) {
    r.runTo(2000);
    expect(r.serial('pico')).toContain('drawn');
    expect(tftPixels(r, 'tft', [[15, 15], [140, 30], [20, 80]])).toEqual([0xf800, 0x07e0, 0x001f]);
  },
  'pico-neopixel'(r) {
    r.runTo(800);
    expect((r.visual('strip')?.pixels as number[] | undefined)?.slice(0, 3)).toEqual([0x00ff00, 0x00ff00, 0x0000ff]);
  },
  'pico-micropython-blink'(r) {
    r.runTo(1200);
    expect(r.serial('pico')).toContain('blink 3\r\n');
    let flips = 0;
    let last: boolean | undefined;
    for (const { visual } of r.history('pico')) {
      const on = (visual.led as number) > 0.3;
      if (last !== undefined && on !== last) flips++;
      last = on;
    }
    expect(flips).toBeGreaterThanOrEqual(3);
  },
  'pico-micropython-neopixel'(r) {
    r.runTo(800);
    expect((r.visual('strip')?.pixels as number[] | undefined)?.slice(0, 4)).toEqual([0x00ff00, 0x00ff00, 0x0000ff, 0x101010]);
  },
  'pico-pio-square'(r) {
    const probe = r.bench.addProbe({ part: 'pico', pin: 'GP3' });
    r.runTo(300);
    const edges = r.bench.readProbe(probe, 0, 1 << 20);
    const rises = [...(edges?.times ?? [])].filter((t, i) => edges?.levels[i] === 1 && t > 100e6);
    const hz = 1e9 / ((rises.at(-1)! - rises[0]) / (rises.length - 1));
    expect(Math.abs(hz - 10_000)).toBeLessThan(50);
  },
  'pico-multicore'(r) {
    // BT82: core 1's LED (GP15, every 250 ms) and core 0's (GP25, every 500 ms), the FIFO talk
    r.runTo(2000);
    expect(r.serial('pico')).toContain('core1 on 1\r\nfifo 1 -> 10\r\nfifo 2 -> 20\r\nfifo 3 -> 30\r\n');
    const flips = (part: string, key: string): number => {
      let count = 0;
      let last: boolean | undefined;
      for (const { visual } of r.history(part)) {
        const on = (visual[key] as number) > 0.3;
        if (last !== undefined && on !== last) count++;
        last = on;
      }
      return count;
    };
    expect(flips('led1', 'brightness')).toBeGreaterThanOrEqual(6);
    expect(flips('pico', 'led')).toBeGreaterThanOrEqual(3);
  },
};

describe('Raspberry Pi Pico examples run (BT61)', () => {
  const pico = EXAMPLES.filter((e) => e.category === 'Raspberry Pi Pico');
  it('checks every Pico example', () => {
    expect(pico.map((e) => e.id).sort()).toEqual(Object.keys(PICO_CHECKS).sort());
  });
  for (const example of pico) {
    it(`${example.id}: ${example.title}`, () => {
      const run = runExample(example);
      PICO_CHECKS[example.id](run);
      expect(run.bench.problems().filter((p) => p.severity === 'error')).toEqual([]);
    }, 60_000);
  }
});
