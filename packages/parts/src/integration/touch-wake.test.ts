import { assembleBench, type Bench, type BenchEnv, NS_PER_MS, type ProjectDoc } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { esp32s2McuFactory } from '@benchtop/esp32s2';
import { esp32s3McuFactory } from '@benchtop/esp32s3';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { loadCachedS2Rom } from '../../../esp32s2/src/test-support/rom.test-helper.ts';
import { loadCachedS3Rom } from '../../../esp32s3/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT160: touch wake from deep sleep on the ESP32, the S2 and the S3 — Arduino's TouchWakeUp shape
// (fixtures/sketches/<chip>/touch-wake: boots counted in RTC memory, touchSleepWakeUpEnable on T3,
// deep sleep): untouched it sleeps on; a touch on the pad wakes it with cause TOUCH, and the woken
// sketch names the pad.

const esp32 = esp32McuFactory(loadCachedRom());
const esp32s2 = esp32s2McuFactory(loadCachedS2Rom());
const esp32s3 = esp32s3McuFactory(loadCachedS3Rom());
const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report, props) => esp32(board, id, report, props) ?? esp32s2(board, id, report, props) ?? esp32s3(board, id, report, props) };

const CHIPS = [
  { name: 'ESP32', dir: 'esp32', board: 'esp32-devkit-v1', header: 'D15', gpio: 15 },
  { name: 'ESP32-S2', dir: 'esp32s2', board: 'esp32-s2-devkitm-1', header: 'IO3', gpio: 3 },
  { name: 'ESP32-S3', dir: 'esp32s3', board: 'esp32-s3-devkitc-1', header: 'IO3', gpio: 3 },
] as const;

function live(chip: (typeof CHIPS)[number]) {
  const doc = {
    format: 1,
    name: 'touch-wake',
    parts: [
      { id: 'b', type: chip.board, x: 0, y: 0, rotation: 0, props: {} },
      { id: 'pad', type: 'touch-pad', x: -40, y: 10, rotation: 0, props: {} },
    ],
    wires: [{ id: 'w1', from: { part: 'b', pin: chip.header }, to: { part: 'pad', pin: 'PAD' }, waypoints: [], color: 'green' }],
    firmware: {},
  } as ProjectDoc;
  const bench: Bench = assembleBench(doc, env, { b: { format: 'esp32-bin', app: readFixture(`fixtures/firmware/${chip.dir}/touch-wake.bin`), partitions: readFixture(`fixtures/firmware/${chip.dir}/touch-wake.partitions.bin`) } });
  let serial = '';
  bench.onSerial('b', (bytes) => (serial += String.fromCharCode(...bytes)));
  return {
    bench,
    serial: () => serial,
    runTo(ms: number): void {
      for (let t = Math.floor(bench.now() / NS_PER_MS) + 10; t <= ms; t += 10) bench.runUntil(t * NS_PER_MS);
    },
  };
}

describe('touch wake from deep sleep (BT160)', () => {
  for (const chip of CHIPS) {
    it(`${chip.name}: sleeps on untouched; a touch on T3 wakes it, and the woken sketch names pad 3`, () => {
      const r = live(chip);
      r.runTo(1500);
      expect(r.serial()).toContain('boot 1: power-on');
      expect(r.serial()).toContain('sleeping');
      const asleep = r.bench.sleepOf('b');
      expect(asleep?.deep).toBe(true);
      expect(asleep?.pins).toContain(`touch T3 (GPIO${chip.gpio})`);
      r.runTo(20_000); // untouched: no wake
      expect(r.serial()).not.toContain('boot 2');
      r.bench.input('pad', { kind: 'press' });
      r.runTo(20_200);
      r.bench.input('pad', { kind: 'release' });
      r.runTo(21_500);
      expect(r.serial()).toContain('boot 2: touch pad 3');
      expect(r.bench.sleepOf('b')?.deep).toBe(true); // asleep again, armed again
      r.bench.input('pad', { kind: 'press' });
      r.runTo(21_700);
      r.bench.input('pad', { kind: 'release' });
      r.runTo(23_000);
      expect(r.serial()).toContain('boot 3: touch pad 3');
      expect(r.bench.problems().filter((p) => p.severity === 'error')).toEqual([]);
    }, 60_000);
  }
});
