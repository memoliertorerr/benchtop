import { avrMcuFactory } from '@benchtop/avr';
import { Bench, NS_PER_MS, parseProject, partPointToWorld, type ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts, CATALOG } from '../catalog.ts';
import { importWokwiDiagram, routeWaypoints, WOKWI_PX_PER_MM, WOKWI_TYPES } from './wokwi.ts';

// BT38: Wokwi diagram.json → ProjectDoc. The sample (fixtures/wokwi/blink-breadboard.diagram.json)
// is written by hand in Wokwi's documented format: an Uno, a half breadboard, an LED and a
// resistor plugged into it (`$bb` connections), two routed wires.

const sample = (): unknown => JSON.parse(readFixtureText('fixtures/wokwi/blink-breadboard.diagram.json'));

function imported(json: unknown = sample()): { doc: ProjectDoc; warnings: string[] } {
  const result = importWokwiDiagram(json);
  if (!result.ok) throw new Error(result.error);
  return result;
}

const pinAt = (doc: ProjectDoc, part: string, pin: string): { x: number; y: number } => {
  const placed = doc.parts.find((p) => p.id === part)!;
  const def = CATALOG.get(placed.type)!;
  const p = def.pins.find((q) => q.name === pin)!;
  return partPointToWorld(placed, def.size, { x: p.x, y: p.y });
};

describe('importWokwiDiagram (BT38)', () => {
  it('imports the sample: a valid project, px → mm, rotation kept, props from attrs, no warnings', () => {
    const { doc, warnings } = imported();
    expect(warnings).toEqual([]);
    expect(parseProject(doc).ok).toBe(true);
    const byId = Object.fromEntries(doc.parts.map((p) => [p.id, p]));
    expect(Object.keys(byId)).toEqual(['uno', 'bb1', 'led1', 'r1']);
    expect(byId.uno).toMatchObject({ type: 'arduino-uno', x: 0, y: 0, rotation: 0 });
    expect(byId.bb1).toMatchObject({ type: 'breadboard-half', rotation: 0 });
    expect(byId.bb1.x).toBeCloseTo(300 / WOKWI_PX_PER_MM, 3);
    expect(byId.bb1.y).toBeCloseTo(-10 / WOKWI_PX_PER_MM, 3);
    expect(byId.r1).toMatchObject({ type: 'resistor', rotation: 180, props: { ohms: 220 } });
    expect(byId.led1).toMatchObject({ type: 'led', props: { color: 'red' } });
  });

  it('plugs breadboard parts into the holes: no wires for $bb connections, every pin within contact distance', () => {
    const { doc } = imported();
    expect(doc.wires.map((w) => `${w.from.part}:${w.from.pin}→${w.to.part}:${w.to.pin}`)).toEqual(['uno:13→bb1:19t.a', 'uno:GND.1→bb1:12t.a']);
    for (const [part, pin, hole] of [
      ['led1', 'A', '13t.c'],
      ['led1', 'C', '12t.c'],
      ['r1', '2', '13t.e'],
      ['r1', '1', '19t.e'],
    ] as const) {
      const a = pinAt(doc, part, pin);
      const b = pinAt(doc, 'bb1', hole);
      expect(Math.hypot(a.x - b.x, a.y - b.y), `${part}:${pin} → ${hole}`).toBeLessThan(0.4);
    }
  });

  it('runs: blink.hex on the imported circuit flashes the LED every 500 ms', () => {
    const { doc } = imported();
    const bench = new Bench(doc, { part: benchEnvParts, createMcu: avrMcuFactory });
    bench.attachFirmware('uno', { format: 'hex', text: readFixtureText('fixtures/firmware/uno/blink.hex') });
    expect(bench.problems()).toEqual([]);
    const seen: number[] = [];
    for (let t = 1; t <= 2100; t++) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) if (part === 'led1') seen.push(Number(visual.brightness));
    }
    expect(seen).toEqual([1, 0, 1, 0, 1]);
  });

  it('turns route moves into waypoints: before * from the source, after * from the target in reverse', () => {
    const { doc } = imported();
    const wire = doc.wires[0];
    const from = pinAt(doc, 'uno', '13');
    const to = pinAt(doc, 'bb1', '19t.a');
    expect(wire.waypoints).toHaveLength(2);
    expect(wire.waypoints[0].x).toBeCloseTo(from.x, 3);
    expect(wire.waypoints[0].y).toBeCloseTo(from.y - 20 / WOKWI_PX_PER_MM, 3);
    expect(wire.waypoints[1].x).toBeCloseTo(to.x, 3);
    expect(wire.waypoints[1].y).toBeCloseTo(to.y - 10 / WOKWI_PX_PER_MM, 3);
    // The documented example: ["v10", "h5", "*", "v-15", "h10"].
    const px = (v: number): number => v / WOKWI_PX_PER_MM;
    const w = routeWaypoints({ x: 0, y: 0 }, { x: 100, y: 100 }, ['v10', 'h5', '*', 'v-15', 'h10'], [], 'test');
    const expected = [
      { x: 0, y: px(10) },
      { x: px(5), y: px(10) },
      { x: 100 + px(10), y: 100 - px(15) },
      { x: 100 + px(10), y: 100 },
    ];
    expect(w.map((p) => [p.x, p.y])).toEqual(expected.map((p) => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000]));
    // No "*": all moves are the source's.
    expect(routeWaypoints({ x: 0, y: 0 }, { x: 9, y: 9 }, ['h9.6'], [], 'test')).toEqual([{ x: 2.54, y: 0 }]);
  });

  it('reports what it can not import as warnings, and never throws on a malformed file', () => {
    const json = sample() as { parts: unknown[]; connections: unknown[] };
    json.parts.push(
      { type: 'wokwi-pi-pico', id: 'pico', top: 0, left: 600 },
      { type: 'wokwi-led', id: 'Big LED!', top: 200, left: 0, rotate: 30, attrs: { color: 'blue', flip: '1' } },
      { type: 'wokwi-7segment', id: 'sevseg', top: 300, left: 0, attrs: { digits: '3' } },
      'not a part',
    );
    json.connections.push(
      ['pico:GP13', 'uno:12', 'green', []],
      ['uno:D99', 'bb1:1t.a', 'green', []],
      ['Big LED!:A', 'uno:2', '', []],
      ['Big LED!:C', 'uno:GND.2', 'red', ['v10', 'x5']],
      ['ghost:1', 'uno:3', 'green', []],
      'not a connection',
    );
    const result = importWokwiDiagram(json);
    if (!result.ok) throw new Error(result.error);
    expect(result.warnings).toEqual([
      'pico: wokwi-pi-pico has no Benchtop part yet; skipped with its connections',
      'Big LED!: attribute flip="1" isn\'t supported; ignored',
      'Big LED!: rotation 30° snapped to 0°',
      'Big LED!: renamed big-led- (ids are lowercase letters, digits, - and _)',
      'sevseg: wokwi-7segment as 3 digits (Benchtop has 1, 2 and 4); skipped with its connections',
      'parts[7]: needs a string "id" and "type"; skipped',
      'connections[7]: Arduino Uno has no pin "D99"; skipped',
      'connections[8]: a hidden wire (Big LED!:A → uno:2) imported green',
      'connections[10]: no part "ghost"; skipped',
      'connections[11]: expected [from, to, color, route]; skipped',
      'wire from Big LED!:C: route ["v10","x5"] isn\'t valid; drawn without it',
    ]);
    expect(result.doc.parts.map((p) => p.id)).toEqual(['uno', 'bb1', 'led1', 'r1', 'big-led-']);
    expect(result.doc.parts[4]).toMatchObject({ type: 'led', rotation: 0, props: { color: 'blue' } });
    for (const bad of [null, 5, 'diagram', [], {}, { parts: 5 }, { parts: [], connections: 7 }, { parts: [{ id: 'x', type: 'wokwi-led', left: Number.NaN }] }]) {
      expect(() => importWokwiDiagram(bad)).not.toThrow();
    }
    expect(importWokwiDiagram(null)).toEqual({ ok: false, error: 'not a diagram: expected a JSON object', warnings: [] });
    expect(importWokwiDiagram({ parts: 5 })).toEqual({ ok: false, error: 'not a diagram: no "parts" array', warnings: [] });
  });

  it('maps by attrs: LCD pins="i2c", 7-segment digits, NeoPixel matrix shape, I2C addresses, slider positions', () => {
    const result = importWokwiDiagram({
      version: 1,
      parts: [
        { type: 'wokwi-lcd1602', id: 'lcd', attrs: { pins: 'i2c', i2cAddress: '0x3f' } },
        { type: 'wokwi-lcd2004', id: 'lcd4', attrs: {} },
        { type: 'wokwi-7segment', id: 'seg', attrs: { digits: '4', common: 'anode', colon: '1' } },
        { type: 'wokwi-neopixel-matrix', id: 'strip', attrs: { rows: '1', cols: '8' } },
        { type: 'wokwi-neopixel-matrix', id: 'matrix', attrs: { rows: '8', cols: '8' } },
        { type: 'wokwi-led-ring', id: 'ring', attrs: { pixels: '16' } },
        { type: 'board-ssd1306', id: 'oled', attrs: { i2cAddress: '0x3d' } },
        { type: 'wokwi-potentiometer', id: 'pot', attrs: { value: '1023' } },
        { type: 'wokwi-resistor', id: 'r', attrs: { value: '4.7k' } },
      ],
      connections: [],
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.warnings).toEqual([]);
    expect(result.doc.parts.map((p) => [p.id, p.type, p.props])).toEqual([
      ['lcd', 'lcd1602-i2c', { address: '0x3F' }],
      ['lcd4', 'lcd2004', {}],
      ['seg', 'seven-segment-4', { common: 'anode', colon: true }],
      ['strip', 'neopixel-strip', {}],
      ['matrix', 'neopixel-matrix', {}],
      ['ring', 'neopixel-ring', {}],
      ['oled', 'ssd1306', { address: '0x3D' }],
      ['pot', 'potentiometer', { value: 1 }],
      ['r', 'resistor', { ohms: 4700 }],
    ]);
  });

  it('maps every Wokwi type it knows to a catalog part whose pins it can name', () => {
    for (const type of WOKWI_TYPES) {
      const result = importWokwiDiagram({ parts: [{ type, id: 'p' }], connections: [] });
      if (!result.ok) throw new Error(`${type}: ${result.error}`);
      expect(result.doc.parts.length, type).toBe(1);
      expect(CATALOG.has(result.doc.parts[0].type), type).toBe(true);
    }
  });
});
