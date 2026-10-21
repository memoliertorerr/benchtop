import { avrMcuFactory } from '@benchtop/avr';
import { Bench, NS_PER_MS, NS_PER_US, parseProject, type ProjectDoc, type VisualState } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// Actuators on a full Bench with real firmware (fixtures/projects/, fixtures/firmware/uno/).

const project = (name: string): ProjectDoc => JSON.parse(readFixtureText(`fixtures/projects/${name}.json`)) as ProjectDoc;

function load(doc: ProjectDoc, firmware: string) {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: avrMcuFactory });
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  let text = '';
  const lines: { text: string; ms: number }[] = [];
  bench.onSerial('uno', (bytes) => {
    text += String.fromCharCode(...bytes);
    let end: number;
    while ((end = text.indexOf('\r\n')) >= 0) {
      lines.push({ text: text.slice(0, end), ms: bench.now() / NS_PER_MS });
      text = text.slice(end + 2);
    }
  });
  /** Every frame a part appeared in: its ms and a copy of its visual. */
  const frames: { part: string; ms: number; visual: VisualState }[] = [];
  const latest = new Map<string, VisualState>();
  let wall = 0;
  const runTo = (ms: number): void => {
    const start = performance.now();
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 1; t <= ms; t++) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) {
        const copy = structuredClone(visual);
        latest.set(part, copy);
        frames.push({ part, ms: t, visual: copy });
      }
    }
    wall += performance.now() - start;
  };
  const mhz = (): string => (((bench.now() / NS_PER_MS) * 16e3) / (wall * 1e3)).toFixed(1);
  return { bench, lines, frames, latest, runTo, mhz };
}

const line = (lines: { text: string; ms: number }[], text: string) => {
  const found = lines.find((l) => l.text === text);
  if (found === undefined) throw new Error(`no line ${JSON.stringify(text)} in ${JSON.stringify(lines.map((l) => l.text))}`);
  return found;
};

/** Consecutive duplicates removed. */
const runs = (values: number[], same: (a: number, b: number) => boolean): number[] =>
  values.filter((v, i) => i === 0 || !same(v, values[i - 1]));

describe('servo', () => {
  it('servo-sweep: target follows each written angle; 20 ms period; Servo.h widths; ≤ 600 °/s horn', () => {
    const { bench, lines, frames, runTo, mhz } = load(project('servo-sweep'), 'servo-sweep');
    expect(bench.problems()).toEqual([]);
    runTo(1750);
    const angles = lines.filter((l) => /^\d+$/.test(l.text)).map((l) => Number(l.text));
    expect(angles).toHaveLength(73);
    expect(line(lines, 'done')).toBeDefined();
    const servo = frames.filter((f) => f.part === 'servo');
    const widths = runs(
      servo.map((f) => f.visual.pulseUs as number).filter((w) => w > 0),
      (a, b) => Math.abs(a - b) < 2,
    );
    expect(widths).toHaveLength(angles.length);
    widths.forEach((w, i) => expect(Math.abs(w - (544 + angles[i] * (1856 / 180))), `pulse ${i}: ${w} µs for ${angles[i]}°`).toBeLessThanOrEqual(8));
    const targets = runs(
      servo.filter((f) => (f.visual.pulseUs as number) > 0).map((f) => f.visual.target as number),
      (a, b) => Math.abs(a - b) < 1,
    );
    expect(targets).toHaveLength(angles.length);
    targets.forEach((t, i) => expect(Math.abs(t - angles[i])).toBeLessThanOrEqual(2));
    const periods = servo.map((f) => f.visual.periodUs as number).filter((p) => p > 0);
    expect(periods.length).toBeGreaterThan(50);
    for (const p of periods) expect(Math.abs(p - 20_000)).toBeLessThanOrEqual(100);
    for (let i = 1; i < servo.length; i++) {
      const rate = Math.abs((servo[i].visual.angle as number) - (servo[i - 1].visual.angle as number)) / ((servo[i].ms - servo[i - 1].ms) / 1000);
      expect(rate).toBeLessThanOrEqual(600.5);
    }
    console.info(`servo-sweep: ${mhz()} simulated MHz`);
  });
});

describe('steppers', () => {
  it('stepper-28byj48: a quarter turn (512 steps) and back to 0', () => {
    const { bench, lines, frames, runTo } = load(project('stepper-28byj48'), 'stepper-28byj48');
    expect(bench.problems()).toEqual([]);
    runTo(2600);
    const at = (ms: number) => frames.filter((f) => f.part === 'motor' && f.ms <= ms).at(-1)?.visual;
    const forward = at(line(lines, 'forward').ms + 2);
    expect(Math.abs((forward?.angle as number) - 90)).toBeLessThanOrEqual(0.2);
    expect(forward?.steps).toBe(512);
    const back = at(line(lines, 'back').ms + 2);
    expect(Math.abs(back?.angle as number)).toBeLessThanOrEqual(0.2);
    expect(back?.steps).toBe(0);
    expect(bench.problems()).toEqual([]);
  });

  it('stepper-28byj48-wrong-order: no rotation, and a stepper-sequence problem', () => {
    const { bench, latest, runTo } = load(project('stepper-28byj48-wrong-order'), 'stepper-28byj48');
    runTo(1200);
    expect(latest.get('motor')?.angle).toBe(0);
    expect(bench.problems()).toEqual([expect.objectContaining({ code: 'stepper-sequence', severity: 'info', parts: ['motor'] })]);
  });

  it('stepper-bipolar: 50 full steps → 90°, 100 half-steps more → 180°', () => {
    const { bench, lines, frames, runTo } = load(project('stepper-bipolar'), 'stepper-bipolar');
    expect(bench.problems()).toEqual([]);
    runTo(1000);
    const at = (ms: number) => frames.filter((f) => f.part === 'motor' && f.ms <= ms).at(-1)?.visual;
    expect(Math.abs((at(line(lines, 'full').ms + 50)?.angle as number) - 90)).toBeLessThanOrEqual(0.2);
    expect(Math.abs((at(line(lines, 'half').ms + 2)?.angle as number) - 180)).toBeLessThanOrEqual(0.2);
  });
});

describe('NeoPixels', () => {
  it('neopixel: the strip and the chained ring show the colors sent, with clean bit timing', () => {
    const { bench, latest, lines, runTo, mhz } = load(project('neopixel'), 'neopixel');
    // The ring's DOUT is the end of the chain: an info, not a fault.
    expect(bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
    runTo(100);
    expect(line(lines, 'sent')).toBeDefined();
    const color = (i: number): number => (((i * 37 + 16) & 255) << 16) | (((255 - i * 9) & 255) << 8) | ((i * 73) & 255);
    const strip = latest.get('strip');
    const ring = latest.get('ring');
    expect(strip?.pixels).toEqual(Array.from({ length: 8 }, (_, i) => color(i)));
    expect(ring?.pixels).toEqual(Array.from({ length: 16 }, (_, i) => color(8 + i)));
    for (const v of [strip, ring]) {
      expect(v?.errors).toBe(0);
      expect(v?.t0hMin as number).toBeGreaterThanOrEqual(250);
      expect(v?.t0hMax as number).toBeLessThanOrEqual(550);
      expect(v?.t1hMin as number).toBeGreaterThanOrEqual(650);
      expect(v?.t1hMax as number).toBeLessThanOrEqual(950);
    }
    expect(strip?.bits).toBe(8 * 24);
    expect(ring?.bits).toBe(16 * 24);
    console.info(`neopixel: T0H ${strip?.t0hMin}–${strip?.t0hMax} ns, T1H ${strip?.t1hMin}–${strip?.t1hMax} ns; ${mhz()} simulated MHz`);
  });
});

describe('buzzer and relay', () => {
  it('buzzer: 440 Hz at 50 %, 880 Hz, silent within 20 ms of noTone; the active buzzer only while D7 is high', () => {
    const { bench, lines, frames, runTo } = load(project('buzzer'), 'buzzer');
    expect(bench.problems()).toEqual([]);
    runTo(1500);
    const at = (part: string, ms: number) => frames.filter((f) => f.part === part && f.ms <= ms).at(-1)?.visual;
    const t440 = line(lines, '440').ms;
    const tone440 = at('bz1', t440 + 200);
    expect(Math.abs((tone440?.frequency as number) - 440)).toBeLessThanOrEqual(1);
    expect(Math.abs((tone440?.duty as number) - 0.5)).toBeLessThanOrEqual(0.02);
    expect(Math.abs((at('bz1', line(lines, '880').ms + 200)?.frequency as number) - 880)).toBeLessThanOrEqual(2);
    expect(at('bz1', line(lines, 'off').ms + 21)?.frequency).toBe(0);
    expect(at('bz2', line(lines, 'active on').ms - 5)?.sounding ?? false).toBe(false);
    expect(at('bz2', line(lines, 'active on').ms + 50)).toMatchObject({ sounding: true, frequency: 2300 });
    expect(at('bz2', line(lines, 'active off').ms + 5)?.sounding).toBe(false);
  });

  it('relay: NO1 closes 4.0 ± 0.1 ms after the coil energizes, the LED lights, NC1 is the complement', () => {
    const { bench, latest, runTo } = load(project('relay'), 'relay');
    expect(bench.problems()).toEqual([]);
    expect(bench.pinState('relay', 'NC1')?.level).toBe(1);
    // Find the coil's first rise and NO1's first rise, sampling every 10 µs.
    let coilAt = -1;
    let noAt = -1;
    while (noAt < 0 && bench.now() < 200 * NS_PER_MS) {
      bench.runUntil(bench.now() + 10 * NS_PER_US);
      if (coilAt < 0 && bench.pinState('relay', 'COIL1')?.level === 1) coilAt = bench.now();
      if (noAt < 0 && bench.pinState('relay', 'NO1')?.level === 1) noAt = bench.now();
    }
    expect(coilAt).toBeGreaterThan(0);
    expect(Math.abs((noAt - coilAt) / NS_PER_MS - 4)).toBeLessThanOrEqual(0.1);
    expect(bench.pinState('relay', 'NC1')?.level).toBeNull();
    runTo(Math.ceil(bench.now() / NS_PER_MS) + 50);
    expect(latest.get('led1')).toEqual({ brightness: 1 });
    expect(latest.get('relay')).toEqual({ energized: true, contactsNO: true });
    runTo(560);
    expect(bench.pinState('relay', 'NO1')?.level).toBeNull();
    expect(bench.pinState('relay', 'NC1')?.level).toBe(1);
    expect(latest.get('led1')).toEqual({ brightness: 0 });
  });
});
