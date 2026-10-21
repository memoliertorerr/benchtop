import { avrMcuFactory } from '@benchtop/avr';
import { Bench, NS_PER_MS, parseProject, type VisualState } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { flameVolts, mq2Volts } from '../shared/transfer.ts';

// BT53: flame and gas modules read by real firmware, and an A4988 turning a bipolar motor in
// full steps and in sixteenth steps.

function load(project: string) {
  const parsed = parseProject(JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: avrMcuFactory });
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${project}.hex`) });
  let serial = '';
  bench.onSerial('uno', (bytes) => (serial += String.fromCharCode(...bytes)));
  const latest = new Map<string, VisualState>();
  const history: { t: number; part: string; visual: VisualState }[] = [];
  const runTo = (ms: number, stepMs = 5): void => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + stepMs; t <= ms; t += stepMs) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) {
        latest.set(part, structuredClone(visual));
        history.push({ t, part, visual: structuredClone(visual) });
      }
    }
  };
  return { bench, runTo, latest, history, serial: () => serial };
}

describe('flame and gas modules (BT53)', () => {
  it('flame: AOUT falls with infrared; past the threshold DOUT goes low and the sketch sounds 2 kHz', () => {
    const t = load('flame-alarm');
    t.runTo(300);
    expect(t.serial()).toBe(`clear a0=${Math.min(1023, Math.floor((flameVolts(0, 5, 0) / 5) * 1024))}\r\n`);
    t.bench.input('flame', { kind: 'value', value: 0.8 });
    t.runTo(400);
    const a0 = Math.floor((flameVolts(0, 5, 0.8) / 5) * 1024);
    expect(t.serial()).toMatch(new RegExp(`FLAME a0=(${a0 - 1}|${a0}|${a0 + 1})\\r\\n$`));
    expect(t.latest.get('flame')).toMatchObject({ ledPower: true, ledSignal: true });
    expect(t.history.some(({ part, visual }) => part === 'bz1' && visual.frequency === 2000)).toBe(true);
    t.bench.input('flame', { kind: 'value', value: 0.2 });
    t.runTo(500);
    expect(t.serial()).toMatch(/clear a0=\d+\r\n$/);
  });

  it('gas: clean air reads ≈ 0.46 V; 1,000 ppm crosses the half-supply threshold and raises the alarm', () => {
    const t = load('gas-meter');
    t.runTo(300);
    const clean = Math.floor((mq2Volts(0, 5, 0) / 5) * 1024);
    expect(t.serial().split('\r\n')[0]).toMatch(new RegExp(`^a0=(${clean - 1}|${clean}|${clean + 1}) alarm=0$`));
    t.bench.input('gas', { kind: 'value', value: 1000 });
    t.runTo(700);
    const high = Math.floor((mq2Volts(0, 5, 1000) / 5) * 1024);
    expect(t.serial().split('\r\n').filter(Boolean).at(-1)).toMatch(new RegExp(`^a0=(${high - 1}|${high}|${high + 1}) alarm=1$`));
    expect(t.latest.get('gas')).toMatchObject({ ledPower: true, ledD0: true });
  });
});

describe('A4988 driver (BT53)', () => {
  it('200 full steps turn the motor once forward; 3,200 sixteenth steps turn it back, in 0.1125° steps', () => {
    const t = load('a4988-stepper');
    t.runTo(1300, 1);
    expect(t.serial()).toBe('full\r\nsixteenth\r\n');
    const angles = t.history.filter((h) => h.part === 'motor').map((h) => ({ t: h.t, angle: h.visual.angle as number }));
    // The turn forward peaks at exactly 360° before the microsteps take it back.
    expect(Math.max(...angles.map((a) => a.angle))).toBeCloseTo(360, 6);
    expect(angles.at(-1)?.angle).toBeCloseTo(0, 6);
    // Microsteps: angles between the full-step ones (1.8°), on the 1.8°/16 grid.
    const fine = angles.filter((a) => a.t > 260 && Math.abs(a.angle / 1.8 - Math.round(a.angle / 1.8)) > 0.01);
    expect(fine.length).toBeGreaterThan(50);
    for (const { angle } of fine) expect(Math.abs(angle / 0.1125 - Math.round(angle / 0.1125))).toBeLessThan(0.01);
    expect(t.bench.problems()).toEqual([]);
  });
});
