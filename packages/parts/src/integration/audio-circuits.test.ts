import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartInstance, type ProjectDoc, type Wire } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { SPEAKER_RATE } from '../actuators/speaker.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';
import { MIC_RATE } from '../sensors/microphone.ts';
import { dominantHz, peakHz, thd } from './spectrum.test-helper.ts';

// BT41: sound both ways. A speaker reconstructs what its pins are driven with as a 22,050 Hz
// stream (tone(), PWM-DAC PCM, the ESP32's DAC); a microphone plays samples a test feeds it into
// an ADC pin.

const ROM = loadCachedRom();
const PERIOD_NS = 1e9 / SPEAKER_RATE;

type Board = 'uno' | 'esp';

/** A board plus parts placed far apart (no contacts), wired as given ("part:pin" pairs). */
function circuit(board: Board, parts: Omit<PartInstance, 'x' | 'y' | 'rotation'>[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'audio test',
    parts: [
      { id: board, type: board === 'uno' ? 'arduino-uno' : 'esp32-devkit-v1', x: 0, y: 0, rotation: 0, props: {} },
      ...parts.map((p, i) => ({ ...p, x: 100 + i * 40, y: 0, rotation: 0 as const })),
    ],
    wires: wires.map(([from, to], i): Wire => {
      const [fp, fn] = from.split(':');
      const [tp, tn] = to.split(':');
      return { id: `w${i}`, from: { part: fp, pin: fn }, to: { part: tp, pin: tn }, waypoints: [], color: 'green' };
    }),
    firmware: {},
  };
}

function load(doc: ProjectDoc, board: Board, firmware: string) {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const esp32 = esp32McuFactory(ROM);
  const env: BenchEnv = { part: benchEnvParts, createMcu: (b, id, report) => avrMcuFactory(b) ?? esp32(b, id, report) };
  const bench = new Bench(parsed.doc, env, { analogSpecFor });
  if (board === 'uno') bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  else {
    bench.attachFirmware('esp', {
      format: 'esp32-bin',
      app: readFixture(`fixtures/firmware/esp32/${firmware}.bin`),
      partitions: readFixture(`fixtures/firmware/esp32/${firmware}.partitions.bin`),
    });
  }
  bench.reset();
  let serial = '';
  bench.onSerial(board, (bytes) => (serial += String.fromCharCode(...bytes)));
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
  /** The stream between two simulated times (ms), missing samples as NaN. */
  const window = (fromMs: number, toMs: number): number[] => {
    const a = Math.ceil((fromMs * NS_PER_MS) / PERIOD_NS);
    const b = Math.floor((toMs * NS_PER_MS) / PERIOD_NS);
    return Array.from({ length: b - a }, (_, i) => audio.get(a + i) ?? Number.NaN);
  };
  const firstSampleMs = (): number => (Math.min(...audio.keys()) * PERIOD_NS) / NS_PER_MS;
  return { bench, runTo, window, firstSampleMs, serial: () => serial };
}

/**
 * The frequency tone() really makes on an Uno's Timer2: Tone.cpp picks the smallest prescaler
 * whose OCR = F_CPU / f / 2 / prescaler − 1 (integer divisions) fits 8 bits — so 659 Hz is
 * 661.4 Hz on the board, and on the bench (the plan's ±2 Hz is around these).
 */
function toneHz(f: number): number {
  const half = Math.floor(Math.floor(16e6 / f) / 2);
  for (const prescaler of [1, 8, 32, 64, 128, 256, 1024]) {
    const ocr = Math.floor(half / prescaler) - 1;
    if (ocr <= 255) return 16e6 / (2 * prescaler * (ocr + 1));
  }
  throw new RangeError(`${f} Hz is below tone()'s range`);
}

describe('speaker (BT41)', () => {
  it('uno/speaker-melody: each 250 ms note peaks within ±2 Hz of the 440, 523 and 659 Hz tone() makes', () => {
    const doc = circuit('uno', [{ id: 'spk', type: 'speaker', props: {} }], [
      ['uno:8', 'spk:1'],
      ['spk:2', 'uno:GND.1'],
    ]);
    const { runTo, window, firstSampleMs, serial } = load(doc, 'uno', 'speaker-melody');
    runTo(1200);
    expect(serial()).toBe('melody\r\n');
    const t0 = firstSampleMs(); // the first tone() edge
    expect([440, 523, 659].map((f) => Math.round(toneHz(f) * 100) / 100)).toEqual([440.14, 523.01, 661.38]);
    [440, 523, 659].forEach((note, k) => {
      const x = window(t0 + k * 250 + 25, t0 + k * 250 + 225);
      expect(x.every((v) => Number.isFinite(v))).toBe(true);
      expect(Math.abs(peakHz(x, SPEAKER_RATE, note - 20, note + 20) - toneHz(note))).toBeLessThanOrEqual(2);
    });
    // After noTone the stream goes quiet: no blocks long after the last note.
    expect(window(t0 + 900, t0 + 1100).every((v) => Number.isNaN(v))).toBe(true);
  });

  it('uno/pcm-playback: 8 kHz PCM through 62.5 kHz PWM comes out as 1,000 ±5 Hz with THD (2nd–5th) under 10 %', () => {
    const doc = circuit('uno', [{ id: 'spk', type: 'speaker', props: {} }], [
      ['uno:3', 'spk:1'],
      ['spk:2', 'uno:GND.1'],
    ]);
    const { runTo, window } = load(doc, 'uno', 'pcm-playback');
    runTo(400); // blocks ship whole (46 ms each)
    const x = window(100, 300);
    expect(x.every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.abs(dominantHz(x, SPEAKER_RATE, 100, 10_000) - 1000)).toBeLessThanOrEqual(5);
    expect(thd(x, SPEAKER_RATE, 1000, [2, 3, 4, 5])).toBeLessThan(0.1);
    // The 62.5 kHz carrier is gone: the sine swings ±~2.5 V around the PWM mean, not 0 ↔ 5 V.
    const min = Math.min(...x);
    const max = Math.max(...x);
    expect(min).toBeGreaterThan(0);
    expect(max).toBeLessThan(5);
  });
});

describe('ESP32 DAC (BT41)', () => {
  it('esp32/dac-sine: GPIO25 follows the codes (code / 255 · 3.3 V ±1 LSB) and a speaker on it peaks at 500 ±3 Hz', () => {
    const doc = circuit('esp', [{ id: 'spk', type: 'speaker', props: {} }], [
      ['esp:D25', 'spk:1'],
      ['spk:2', 'esp:GND.1'],
    ]);
    const { bench, runTo, window, serial } = load(doc, 'esp', 'dac-sine');
    for (let ms = 50; ms <= 2000 && !serial().includes('dac'); ms += 50) runTo(ms, 50);
    expect(serial()).toContain('dac\r\n');
    const start = bench.now() / NS_PER_MS;
    // Sample the pin's volts at odd moments: each is a table code's voltage, within 1 LSB.
    const table = Array.from({ length: 32 }, (_, i) => Math.round(127.5 + 127.5 * Math.sin((2 * Math.PI * i) / 32)));
    const lsb = 3.3 / 255;
    const seen = new Set<number>();
    for (let k = 0; k < 200; k++) {
      bench.runUntil(bench.now() + 37_000 + (k % 7) * 3_000);
      const volts = bench.pinState('esp', 'D25')?.volts ?? Number.NaN;
      const code = table.reduce((best, c) => (Math.abs(c * lsb - volts) < Math.abs(best * lsb - volts) ? c : best), table[0]);
      expect(Math.abs(code * lsb - volts)).toBeLessThanOrEqual(lsb);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThanOrEqual(12);
    runTo(Math.ceil(start) + 400);
    const x = window(start + 60, start + 300);
    expect(x.every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.abs(dominantHz(x, SPEAKER_RATE, 100, 5000) - 500)).toBeLessThanOrEqual(3);
  }, 60_000);
});

describe('microphone (BT41)', () => {
  /** Feeds a 440 Hz sine (amplitude 0.5) into the microphone as simulated time runs. */
  function listen(bench: Bench, untilMs: number, serial: () => string): number[] {
    const input = { kind: 'value' as const, value: 0 };
    let n = 0;
    for (let ms = 20; ms <= untilMs; ms += 20) {
      // 20 ms of samples, a little ahead of time (the model keeps up to 200 ms).
      const end = (ms * MIC_RATE) / 1000;
      for (; n < end; n++) {
        input.value = 0.5 * Math.sin((2 * Math.PI * 440 * n) / MIC_RATE);
        bench.input('mic', input);
      }
      bench.runUntil(ms * NS_PER_MS);
    }
    return serial()
      .split('\r\n')
      .filter((line) => line !== '')
      .map(Number);
  }

  it('uno/mic-level: a 440 Hz tone into A0 reads as 440 ±10 Hz', () => {
    const doc = circuit('uno', [{ id: 'mic', type: 'microphone', props: {} }], [
      ['mic:OUT', 'uno:A0'],
      ['mic:VCC', 'uno:5V'],
      ['mic:GND', 'uno:GND.2'],
    ]);
    const { bench, serial } = load(doc, 'uno', 'mic-level');
    const readings = listen(bench, 1600, serial); // readings at ~0.5, 1.0, 1.5 s
    expect(readings.length).toBeGreaterThanOrEqual(3);
    // The first window starts before the tone settles; the rest track it.
    for (const hz of readings.slice(1)) expect(Math.abs(hz - 440)).toBeLessThanOrEqual(10);
  });

  it('esp32/mic-level: a 440 Hz tone into GPIO34 reads as 440 ±10 Hz', () => {
    const doc = circuit('esp', [{ id: 'mic', type: 'microphone', props: {} }], [
      ['mic:OUT', 'esp:D34'],
      ['mic:VCC', 'esp:3V3'],
      ['mic:GND', 'esp:GND.1'],
    ]);
    const { bench, serial } = load(doc, 'esp', 'mic-level');
    const readings = listen(bench, 1600, serial); // readings at ~0.52, 1.02, 1.52 s
    expect(readings.length).toBeGreaterThanOrEqual(3);
    for (const hz of readings.slice(1)) expect(Math.abs(hz - 440)).toBeLessThanOrEqual(10);
  }, 60_000);

  it('holds VCC/2 when nothing plays, drops what is more than 200 ms ahead, and stops its timer when idle', () => {
    const doc = circuit('uno', [{ id: 'mic', type: 'microphone', props: { gain: 1 } }], [
      ['mic:OUT', 'uno:A0'],
      ['mic:VCC', 'uno:5V'],
      ['mic:GND', 'uno:GND.2'],
    ]);
    const { bench } = load(doc, 'uno', 'mic-level');
    bench.runUntil(5 * NS_PER_MS);
    expect(bench.pinState('mic', 'OUT')?.volts).toBeCloseTo(2.5, 9);
    const input = { kind: 'value' as const, value: 1 };
    for (let i = 0; i < MIC_RATE; i++) bench.input('mic', input); // a whole second at once
    bench.runUntil(6 * NS_PER_MS);
    expect(bench.pinState('mic', 'OUT')?.volts).toBeCloseTo(3.5, 9); // 2.5 V + 1 V · 1
    const visual = bench.collectFrame().parts.find(([id]) => id === 'mic')?.[1];
    expect(visual?.dropped).toBe(MIC_RATE - MIC_RATE / 5);
    // 200 ms of samples, then 100 ms of silence: idle again, back at the midpoint.
    bench.runUntil(400 * NS_PER_MS);
    expect(bench.pinState('mic', 'OUT')?.volts).toBeCloseTo(2.5, 9);
    expect(bench.collectFrame().parts.find(([id]) => id === 'mic')?.[1]).toMatchObject({ listening: false });
  });
});
