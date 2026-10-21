import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './manifest.ts';
import { type ExampleRun, runExample, tftPixels } from './run.test-helper.ts';

// BT66: every Raspberry Pi Pico 2 example runs in Node on the RP2350's RISC-V cores (through the
// real bootrom from .cache/rp2350-rom) and does what its card says (Pico: examples-run-pico.test.ts);
// BT67's MicroPython example on the cached RPI_PICO2-RISCV UF2.

const brightness = (r: ExampleRun, part: string): number => (r.visual(part)?.brightness as number | undefined) ?? 0;

export const PICO2_CHECKS: Record<string, (r: ExampleRun) => void> = {
  'pico2-blink'(r) {
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
  'pico2-potentiometer'(r) {
    r.runTo(500);
    r.input('pot', { kind: 'value', value: 0.75 });
    r.runTo(1000);
    const readings = [...r.serial('pico').matchAll(/adc=(\d+)/g)].map((m) => Number(m[1]));
    expect(Math.abs((readings.at(-1) ?? 0) - 3071)).toBeLessThanOrEqual(8);
  },
  'pico2-fade'(r) {
    r.runTo(300);
    const quarter = brightness(r, 'led1');
    r.runTo(700);
    const threeQuarters = brightness(r, 'led1');
    expect(threeQuarters).toBeGreaterThan(quarter);
  },
  'pico2-oled'(r) {
    r.runTo(2000);
    expect(r.serial('pico')).toContain('frame 1');
    const fb = (r.visual('oled')?.fb ?? []) as number[];
    expect(fb[0] & 0xff).toBe(0xff); // the filled box's top-left column, page 0
  },
  'pico2-tft'(r) {
    r.runTo(2000);
    expect(r.serial('pico')).toContain('drawn');
    expect(tftPixels(r, 'tft', [[15, 15], [140, 30], [20, 80]])).toEqual([0xf800, 0x07e0, 0x001f]);
  },
  'pico2-neopixel'(r) {
    r.runTo(800);
    expect((r.visual('strip')?.pixels as number[] | undefined)?.slice(0, 3)).toEqual([0x00ff00, 0x00ff00, 0x0000ff]);
  },
  'pico2-micropython-blink'(r) {
    r.runTo(1500);
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
  'pico2-button-irq'(r) {
    r.runTo(300);
    r.input('btn1', { kind: 'press' });
    r.runTo(400);
    r.input('btn1', { kind: 'release' });
    r.runTo(500);
    expect(r.serial('pico')).toContain('presses=1\r\n');
    expect(r.serial('pico')).not.toContain('presses=2');
  },
};

describe('Raspberry Pi Pico 2 examples run (BT66)', () => {
  const pico2 = EXAMPLES.filter((e) => e.category === 'Raspberry Pi Pico 2');
  it('checks every Pico 2 example', () => {
    expect(pico2.map((e) => e.id).sort()).toEqual(Object.keys(PICO2_CHECKS).sort());
  });
  for (const example of pico2) {
    it(`${example.id}: ${example.title}`, () => {
      const run = runExample(example);
      PICO2_CHECKS[example.id](run);
      expect(run.bench.problems().filter((p) => p.severity === 'error')).toEqual([]);
    }, 60_000);
  }
});
