import { assembleBench, type Bench, type BenchEnv, type FirmwareImage, NS_PER_MS, type ProjectDoc } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT159: the ESP32's touch sensor (version 1: readings fall when touched) on a full Bench — a
// touch pad on T0 (GPIO4, the DevKit V1's D4), T3 (GPIO15) bare — with Arduino's touchRead and
// touchAttachInterrupt (fixtures/sketches/esp32/touch-read, touch-interrupt).

const env: BenchEnv = { part: benchEnvParts, createMcu: esp32McuFactory(loadCachedRom()) };

function image(name: string): FirmwareImage {
  return { format: 'esp32-bin', app: readFixture(`fixtures/firmware/esp32/${name}.bin`), partitions: readFixture(`fixtures/firmware/esp32/${name}.partitions.bin`) };
}

const doc: ProjectDoc = {
  format: 1,
  name: 'esp32-touch',
  parts: [
    { id: 'esp', type: 'esp32-devkit-v1', x: 0, y: 0, rotation: 0, props: {} },
    { id: 'pad', type: 'touch-pad', x: 50, y: 10, rotation: 0, props: {} },
  ],
  wires: [{ id: 'w1', from: { part: 'esp', pin: 'D4' }, to: { part: 'pad', pin: 'PAD' }, waypoints: [], color: 'green' }],
  firmware: {},
} as ProjectDoc;

function live(firmware: string) {
  const bench: Bench = assembleBench(doc, env, { esp: image(firmware) });
  let serial = '';
  bench.onSerial('esp', (bytes) => (serial += String.fromCharCode(...bytes)));
  return {
    bench,
    serial: () => serial,
    runTo(ms: number): void {
      for (let t = Math.floor(bench.now() / NS_PER_MS) + 5; t <= ms; t += 5) bench.runUntil(t * NS_PER_MS);
    },
  };
}

function lastReading(serial: string): { t0: number; t3: number } {
  const last = [...serial.matchAll(/t0 (\d+) t3 (\d+)\n/g)].at(-1);
  if (last === undefined) throw new Error(`no reading in ${JSON.stringify(serial.slice(-200))}`);
  return { t0: Number(last[1]), t3: Number(last[2]) };
}

describe('the ESP32’s touch pins on the bench (BT159)', () => {
  it('touchRead: a bare pin reads the most cycles, a touch pad fewer, a finger on it far fewer — and back on release', () => {
    const r = live('touch-read');
    r.runTo(800);
    expect(r.serial()).toContain('touch ready');
    const idle = lastReading(r.serial());
    expect(idle.t3).toBeGreaterThan(60); // nothing on T3: the pad alone (≈ 80)
    expect(idle.t3).toBeLessThan(100);
    expect(idle.t0).toBeLessThan(idle.t3); // the touch pad's electrode adds a little
    expect(idle.t3 - idle.t0).toBeLessThan(25);
    r.bench.input('pad', { kind: 'press' });
    r.runTo(r.bench.now() / NS_PER_MS + 200);
    const touched = lastReading(r.serial());
    expect(idle.t0 - touched.t0).toBeGreaterThan(20);
    expect(touched.t3).toBe(idle.t3);
    r.bench.input('pad', { kind: 'release' });
    r.runTo(r.bench.now() / NS_PER_MS + 200);
    expect(lastReading(r.serial()).t0).toBe(idle.t0);
    expect(r.bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('touchAttachInterrupt (threshold 40): called every round while touched, not before, not after the release', () => {
    const r = live('touch-interrupt');
    r.runTo(600);
    expect(r.serial()).toContain('ready');
    const calls = (): number => Number([...r.serial().matchAll(/calls (\d+)/g)].at(-1)?.[1] ?? -1);
    expect(calls()).toBe(0);
    r.bench.input('pad', { kind: 'press' });
    r.runTo(r.bench.now() / NS_PER_MS + 300);
    const held = calls();
    expect(held).toBeGreaterThan(3); // a round every ≈ 28 ms (4096 slow-clock cycles and the window)
    r.runTo(r.bench.now() / NS_PER_MS + 300);
    expect(calls()).toBeGreaterThan(held); // still touched: still called
    r.bench.input('pad', { kind: 'release' });
    r.runTo(r.bench.now() / NS_PER_MS + 150);
    const after = calls();
    r.runTo(r.bench.now() / NS_PER_MS + 300);
    expect(calls()).toBe(after);
  });
});
