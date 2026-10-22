import { avrMcuFactory } from '@benchtop/avr';
import { assembleBench, type Bench, type BenchEnv, type FirmwareImage, NS_PER_MS, type PartInstance, type ProjectDoc, type VisualState, type Wire } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { rp2040McuFactory } from '@benchtop/rp2040';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT78: editing a running circuit with real firmware — the bench is rebuilt with `carry`, so the
// boards keep running (no second boot) and unchanged parts keep their state.

const ROM = loadCachedRom();
const esp32 = esp32McuFactory(ROM);
const env: BenchEnv = {
  part: benchEnvParts,
  createMcu: (board, id, report) => avrMcuFactory(board) ?? (board.mcu === 'esp32' ? esp32(board, id, report) : rp2040McuFactory(board, id, report)),
};

function project(name: string): ProjectDoc {
  return JSON.parse(readFixtureText(`fixtures/projects/${name}.json`)) as ProjectDoc;
}

/** A bench that survives edits: `edit(doc)` rebuilds it with carry-over; serial and states keep collecting. */
function live(doc: ProjectDoc, board: string, image: FirmwareImage) {
  let bench: Bench = assembleBench(doc, env, { [board]: image });
  let serial = '';
  const listen = (b: Bench): void => b.onSerial(board, (bytes) => (serial += String.fromCharCode(...bytes)));
  listen(bench);
  const latest = new Map<string, VisualState>();
  const collect = (): void => {
    for (const [part, visual] of bench.collectFrame().parts) latest.set(part, structuredClone(visual));
  };
  return {
    bench: () => bench,
    serial: () => serial,
    latest,
    /** Runs to `ms` in `step` ms slices, calling `each` after each. */
    runTo(ms: number, step = 5, each?: () => void): void {
      for (let t = Math.floor(bench.now() / NS_PER_MS) + step; t <= ms; t += step) {
        bench.runUntil(t * NS_PER_MS);
        collect();
        each?.();
      }
    },
    edit(next: ProjectDoc): void {
      bench = assembleBench(next, env, { [board]: image }, { carry: bench.carry() });
      listen(bench);
      collect();
    },
  };
}

/** Times (ms) a pin's level changes, sampled after each slice. */
function edgeLog(get: () => Bench, part: string, pin: string) {
  const edges: number[] = [];
  let last: number | null | undefined;
  return {
    edges,
    sample(): void {
      const level = get().pinState(part, pin)?.level;
      if (last !== undefined && level !== last) edges.push(get().now() / NS_PER_MS);
      last = level;
    },
  };
}

const part = (id: string, type: string, x: number, y: number, props: PartInstance['props'] = {}): PartInstance => ({ id, type, x, y, rotation: 0, props });
const wire = (id: string, a: [string, string], b: [string, string]): Wire => ({ id, from: { part: a[0], pin: a[1] }, to: { part: b[0], pin: b[1] }, waypoints: [], color: 'green' });

/** `doc` plus a red LED and a 220 Ω resistor in series from `pin` to `gnd` of `board`, off to the side. */
function withLed(doc: ProjectDoc, board: string, pin: string, gnd: string): ProjectDoc {
  return {
    ...doc,
    parts: [...doc.parts, part('rx', 'resistor', 300, 200, { ohms: 220 }), part('ledx', 'led', 340, 200, { color: 'red' })],
    wires: [...doc.wires, wire('wx1', [board, pin], ['rx', '1']), wire('wx2', ['rx', '2'], ['ledx', 'A']), wire('wx3', ['ledx', 'C'], [board, gnd])],
  };
}

function rows(visual: VisualState | undefined, cols: number): string[] {
  const chars = (visual?.characters ?? []) as number[];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += cols) out.push(String.fromCharCode(...chars.slice(i, i + cols)));
  return out;
}

describe('editing a running circuit (BT78)', () => {
  it('Uno + I2C LCD: a part added at 1.2 s — the LCD keeps its text, millis() keeps counting, no second boot', () => {
    const t = live(project('lcd-i2c'), 'uno', { format: 'hex', text: readFixtureText('fixtures/firmware/uno/lcd-i2c.hex') });
    t.runTo(1200);
    expect(rows(t.latest.get('lcd1'), 16)).toEqual(['Hello, Benchtop!', 't=1             ']);
    t.edit(withLed(project('lcd-i2c'), 'uno', '13', 'GND.2'));
    expect(t.bench().carriedBoard('uno')).toBe(true);
    expect(t.bench().now()).toBe(1200 * NS_PER_MS);
    expect(rows(t.latest.get('lcd1'), 16)).toEqual(['Hello, Benchtop!', 't=1             ']); // the kept model's state, in the first frame
    t.runTo(1520);
    expect(t.latest.get('lcd1')?.backlight).toBe(false); // at 1.5 s of the sketch's own time
    t.runTo(2100);
    expect(rows(t.latest.get('lcd1'), 16)).toEqual(['Hello, Benchtop!', 't=2             ']);
    expect(t.serial().split('\r\n').filter((l) => l.startsWith('nack='))).toEqual(['nack=2']);
    expect(t.bench().problems().filter((p) => p.severity === 'error')).toEqual([]);
  }, 30_000);

  it('Uno blink: an LED added on pin 13 at 1.2 s blinks on the sketch\'s running schedule', () => {
    const t = live(project('blink-led'), 'uno', { format: 'hex', text: readFixtureText('fixtures/firmware/uno/blink.hex') });
    t.runTo(1200);
    t.edit(withLed(project('blink-led'), 'uno', '13', 'GND.2'));
    const log = edgeLog(t.bench, 'ledx', 'A');
    log.sample();
    t.runTo(3200, 5, log.sample);
    // high 1000–1500, low 1500–2000, … (each edge just after its 500 ms mark, seen by the next
    // 5 ms sample): a restart at 1.2 s would have put them 200 ms later
    expect(log.edges).toEqual([1505, 2005, 2505, 3005]);
    expect(t.serial()).toBe('hello\r\n');
    expect(t.latest.get('ledx')?.brightness).toBeDefined();
  }, 30_000);

  it('Pico blink: the board keeps blinking on its own schedule across an edit', () => {
    const t = live(project('pico-blink'), 'pico', { format: 'uf2', bytes: readFixture('fixtures/firmware/pico/blink.uf2') });
    const before = edgeLog(t.bench, 'pico', 'TP5');
    t.runTo(1700, 5, before.sample);
    t.edit(withLed(project('pico-blink'), 'pico', 'GP15', 'GND.1'));
    expect(t.bench().carriedBoard('pico')).toBe(true);
    const after = edgeLog(t.bench, 'pico', 'TP5');
    after.sample();
    t.runTo(3000, 5, after.sample);
    const last = before.edges.at(-1) as number;
    expect(before.edges.length).toBeGreaterThanOrEqual(2);
    expect(after.edges[0] - last).toBeGreaterThanOrEqual(495); // the next edge 500 ms after the last one
    expect(after.edges[0] - last).toBeLessThanOrEqual(505);
  }, 60_000);

  it('ESP32 blink: the board keeps blinking on its own schedule across an edit', () => {
    const doc = project('esp32-blink');
    const image: FirmwareImage = {
      format: 'esp32-bin',
      app: readFixture('fixtures/firmware/esp32/blink.bin'),
      partitions: readFixture('fixtures/firmware/esp32/blink.partitions.bin'),
    };
    const t = live(doc, 'esp', image);
    const before = edgeLog(t.bench, 'esp', 'D2');
    t.runTo(1700, 5, before.sample);
    t.edit(withLed(doc, 'esp', 'D4', 'GND.2'));
    expect(t.bench().carriedBoard('esp')).toBe(true);
    const after = edgeLog(t.bench, 'esp', 'D2');
    after.sample();
    t.runTo(3000, 5, after.sample);
    const last = before.edges.at(-1) as number;
    expect(before.edges.length).toBeGreaterThanOrEqual(2);
    expect(after.edges[0] - last).toBeGreaterThanOrEqual(495);
    expect(after.edges[0] - last).toBeLessThanOrEqual(505);
  }, 60_000);
});
