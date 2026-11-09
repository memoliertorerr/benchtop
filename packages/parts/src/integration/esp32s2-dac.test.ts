import { Bench, type BenchEnv, NS_PER_MS, parseProject, type ProjectDoc } from '@benchtop/core';
import { esp32s2McuFactory } from '@benchtop/esp32s2';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedS2Rom } from '../../../esp32s2/src/test-support/rom.test-helper.ts';
import { SPEAKER_RATE } from '../actuators/speaker.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';
import { dominantHz } from './spectrum.test-helper.ts';

// BT164: the S2's DAC on a full bench — esp32s2/dac-sine (the ESP32's dac-sine on GPIO17, DAC
// channel 1) into a speaker, as the ESP32's (audio-circuits.test.ts, BT41).

const PERIOD_NS = 1e9 / SPEAKER_RATE;

describe('ESP32-S2 DAC (BT164)', () => {
  it('esp32s2/dac-sine: IO17 follows the codes (code / 255 · 3.3 V ±1 LSB) and a speaker on it peaks at 500 ±3 Hz', () => {
    const doc = {
      format: 1,
      name: 's2-dac',
      parts: [
        { id: 's2', type: 'esp32-s2-devkitm-1', x: 0, y: 0, rotation: 0, props: {} },
        { id: 'spk', type: 'speaker', x: 100, y: 0, rotation: 0, props: {} },
      ],
      wires: [
        { id: 'w1', from: { part: 's2', pin: 'IO17' }, to: { part: 'spk', pin: '1' }, waypoints: [], color: 'green' },
        { id: 'w2', from: { part: 'spk', pin: '2' }, to: { part: 's2', pin: 'GND.1' }, waypoints: [], color: 'black' },
      ],
      firmware: {},
    } as ProjectDoc;
    const parsed = parseProject(doc);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const env: BenchEnv = { part: benchEnvParts, createMcu: esp32s2McuFactory(loadCachedS2Rom()) };
    const bench = new Bench(parsed.doc, env, { analogSpecFor });
    bench.attachFirmware('s2', { format: 'esp32-bin', app: readFixture('fixtures/firmware/esp32s2/dac-sine.bin'), partitions: readFixture('fixtures/firmware/esp32s2/dac-sine.partitions.bin') });
    bench.reset();
    let serial = '';
    bench.onSerial('s2', (bytes) => (serial += String.fromCharCode(...bytes)));
    // The speaker's stream, by absolute sample index (blocks carry their start time).
    const audio = new Map<number, number>();
    const collect = (): void => {
      for (const [id, visual] of bench.collectFrame().parts) {
        if (id !== 'spk' || !Array.isArray(visual.audio)) continue;
        const samples = visual.audio as readonly number[];
        const starts = visual.audioT as readonly number[];
        starts.forEach((t, b) => {
          const first = Math.round(t / PERIOD_NS);
          for (let i = 0; i < 1024; i++) audio.set(first + i, samples[b * 1024 + i]);
        });
      }
    };
    const runTo = (ms: number, stepMs = 5): void => {
      for (let t = Math.floor(bench.now() / NS_PER_MS) + stepMs; t <= ms; t += stepMs) {
        bench.runUntil(t * NS_PER_MS);
        collect();
      }
    };
    for (let ms = 50; ms <= 2000 && !serial.includes('dac'); ms += 50) runTo(ms, 50);
    expect(serial).toContain('dac\r\n');
    const start = bench.now() / NS_PER_MS;
    // Sample the pin's volts at odd moments: each is a table code's voltage, within 1 LSB.
    const table = Array.from({ length: 32 }, (_, i) => Math.round(127.5 + 127.5 * Math.sin((2 * Math.PI * i) / 32)));
    const lsb = 3.3 / 255;
    const seen = new Set<number>();
    for (let k = 0; k < 200; k++) {
      bench.runUntil(bench.now() + 37_000 + (k % 7) * 3_000);
      const volts = bench.pinState('s2', 'IO17')?.volts ?? Number.NaN;
      const code = table.reduce((best, c) => (Math.abs(c * lsb - volts) < Math.abs(best * lsb - volts) ? c : best), table[0]);
      expect(Math.abs(code * lsb - volts)).toBeLessThanOrEqual(lsb);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThanOrEqual(12);
    runTo(Math.ceil(start) + 400);
    const window = (fromMs: number, toMs: number): number[] => {
      const a = Math.ceil((fromMs * NS_PER_MS) / PERIOD_NS);
      const b = Math.floor((toMs * NS_PER_MS) / PERIOD_NS);
      return Array.from({ length: b - a }, (_, i) => audio.get(a + i) ?? Number.NaN);
    };
    const x = window(start + 60, start + 300);
    expect(x.every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.abs(dominantHz(x, SPEAKER_RATE, 100, 5000) - 500)).toBeLessThanOrEqual(3);
  }, 60_000);
});
