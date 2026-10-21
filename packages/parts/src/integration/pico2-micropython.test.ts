import { Bench, type BenchEnv, NS_PER_MS, parseProject, type VisualState } from '@benchtop/core';
import { MICROPYTHON_PICO2_RISCV } from '@benchtop/rp2040';
import { rp2350McuFactory } from '@benchtop/rp2350';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { cachedMicroPython, micropythonFixture } from '../../../rp2040/src/micropython.test-helper.ts';
import { cachedRom } from '../../../rp2350/src/rp2350.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT67: the Pico's MicroPython sketches on Pico 2 benches — machine.ADC from a potentiometer, the
// neopixel module (machine.bitstream, timed by the CPU's cycle counter) into the NeoPixel strip —
// on the stock RPI_PICO2-RISCV UF2 and the RP2350 bootrom (both from .cache: these tests fail
// with the fetch commands without them).

function load(project: string, sketch: string) {
  const files = { rom: cachedRom(), micropython: cachedMicroPython(MICROPYTHON_PICO2_RISCV) };
  const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => rp2350McuFactory(board, id, report, files) };
  const parsed = parseProject(JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env);
  bench.attachFirmware('pico', micropythonFixture(sketch));
  bench.reset();
  let serial = '';
  bench.onSerial('pico', (bytes) => (serial += String.fromCharCode(...bytes)));
  const latest = new Map<string, VisualState>();
  const runTo = (ms: number, every = 5, each?: (ms: number) => void): void => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + every; t <= ms; t += every) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) latest.set(part, structuredClone(visual));
      each?.(t);
    }
  };
  return { bench, runTo, latest, serial: () => serial };
}

describe('MicroPython on Raspberry Pi Pico 2 benches (BT67)', () => {
  it('adc: machine.ADC(26).read_u16() follows the potentiometer within ±8 of 12 bits', () => {
    const t = load('pico2-analog-read', 'adc');
    for (const position of [0.25, 0.75, 1, 0]) {
      t.bench.input('pot', { kind: 'value', value: position });
      const before = t.serial().length;
      t.runTo(Math.floor(t.bench.now() / NS_PER_MS) + 300);
      const readings = [...t.serial().slice(before).matchAll(/adc=(\d+)/g)].map((m) => Number(m[1]));
      expect(readings.length).toBeGreaterThan(0);
      const last = readings.at(-1) as number;
      expect(Math.abs(last - Math.round(position * 4095)), `position ${position}: ${last}`).toBeLessThanOrEqual(8);
    }
    expect(t.bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
  }, 30_000);

  it('neopixel: the neopixel module lights the strip with the sketch\'s colors', () => {
    const t = load('pico2-neopixel', 'neopixel');
    const firsts: number[] = [];
    t.runTo(1600, 50, (ms) => {
      if (ms % 500 === 250) firsts.push(Number((t.latest.get('strip')?.pixels as number[] | undefined)?.[0] ?? -1));
    });
    expect(t.serial()).toContain('shown 2\r\n');
    expect(firsts).toEqual([0xff0000, 0x00ff00, 0x0000ff]);
    const strip = t.latest.get('strip');
    expect((strip?.pixels as number[]).slice(1)).toEqual([0x00ff00, 0x0000ff, 0x101010, 0, 0, 0, 0]);
    expect(strip?.errors).toBe(0);
    expect(t.bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
  }, 30_000);
});
