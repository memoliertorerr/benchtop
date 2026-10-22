import { CATALOG } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { footprintOf, formatOhms, isOffBoard, PITCH, refPrefix, snapRuns, valueOf } from './footprints.ts';

describe('footprints for the catalog (BT57)', () => {
  it('every part is either on a PCB with a footprint or off-board, and every pad is a real pin', () => {
    const off: string[] = [];
    for (const def of CATALOG.values()) {
      const fp = footprintOf(def);
      if (fp === null) {
        expect(isOffBoard(def)).toBe(true);
        off.push(def.type);
        continue;
      }
      const pins = new Set(def.pins.map((p) => p.name));
      expect(fp.pads.length).toBe(def.pins.length);
      for (const pad of fp.pads) {
        expect(pins.has(pad.pin), `${def.type}:${pad.pin}`).toBe(true);
        expect(pad.drill).toBeGreaterThan(0);
        expect(Math.min(pad.w, pad.h)).toBeGreaterThan(pad.drill);
      }
      expect(new Set(fp.pads.map((p) => p.pin)).size).toBe(fp.pads.length);
      // The courtyard holds every pad.
      for (const pad of fp.pads) {
        expect(pad.x - pad.w / 2).toBeGreaterThanOrEqual(fp.courtyard.x0);
        expect(pad.x + pad.w / 2).toBeLessThanOrEqual(fp.courtyard.x1);
        expect(pad.y - pad.h / 2).toBeGreaterThanOrEqual(fp.courtyard.y0);
        expect(pad.y + pad.h / 2).toBeLessThanOrEqual(fp.courtyard.y1);
      }
    }
    expect(off.sort()).toEqual(['bench-supply', 'breadboard', 'breadboard-half', 'breadboard-mini', 'environment', 'fan', 'flame', 'gas-leak', 'ground', 'heater', 'ir-remote', 'lamp', 'object', 'person', 'sound-source']);
  });

  it('snaps header runs to an exact 0.1″ pitch: the Uno, an LCD, a Nano', () => {
    const at = (type: string, pin: string): { x: number; y: number } => footprintOf(CATALOG.get(type)!)!.pads.find((p) => p.pin === pin)!;
    // Uno: D8–D13 + GND/AREF/SDA/SCL is one 10-pin header; D0–D7 another, 0.16″ (4.064 mm) further.
    expect(at('arduino-uno', '12').x - at('arduino-uno', '13').x).toBeCloseTo(PITCH, 9);
    expect(at('arduino-uno', '8').x - at('arduino-uno', 'A5.2').x).toBeCloseTo(9 * PITCH, 9);
    expect(at('arduino-uno', '7').x - at('arduino-uno', '8').x).toBeCloseTo(4.064, 0);
    expect(at('arduino-uno', '0').x - at('arduino-uno', '7').x).toBeCloseTo(7 * PITCH, 9);
    expect(at('lcd1602', 'K').x - at('lcd1602', 'VSS').x).toBeCloseTo(15 * PITCH, 9);
    // The Nano's two rows: 15 pins each, 0.6″ apart.
    expect(at('arduino-nano', '1').x - at('arduino-nano', '12').x).toBeCloseTo(14 * PITCH, 9);
    expect(Math.abs(at('arduino-nano', '13').y - at('arduino-nano', '12').y)).toBeCloseTo(15.24, 1);
  });

  it('uses standard footprints for the basic components', () => {
    const r = footprintOf(CATALOG.get('resistor')!)!;
    expect(r.pads.map((p) => [p.number, p.x])).toEqual([
      ['1', -5.08],
      ['2', 5.08],
    ]);
    const led = footprintOf(CATALOG.get('led')!)!;
    expect(led.pads.map((p) => [p.number, p.pin, p.shape])).toEqual([
      ['1', 'C', 'rect'],
      ['2', 'A', 'circle'],
    ]);
    // A pushbutton's legs on one side are one contact: one pad number.
    const sw = footprintOf(CATALOG.get('pushbutton')!)!;
    expect(sw.pads.map((p) => `${p.pin}=${p.number}`)).toEqual(['1.l=1', '2.l=2', '1.r=1', '2.r=2']);
    // A board's GND pins share a number too.
    const uno = footprintOf(CATALOG.get('arduino-uno')!)!;
    const gnd = new Set(uno.pads.filter((p) => p.pin.startsWith('GND')).map((p) => p.number));
    expect(gnd.size).toBe(1);
  });

  it('snapRuns leaves isolated pins and snaps a run from its first pin', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 2.52, y: 0.05 },
      { x: 5.1, y: -0.05 },
      { x: 20, y: 0 },
      { x: 30, y: 7 },
    ];
    snapRuns(pts);
    expect(pts.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [2.54, 0],
      [5.08, 0],
      [20, 0],
      [30, 7],
    ]);
  });

  it('names references and values', () => {
    expect(['resistor', 'led', 'pushbutton', 'arduino-uno', 'lcd1602', 'dht22', 'servo'].map((t) => refPrefix(CATALOG.get(t)!))).toEqual(['R', 'D', 'SW', 'A', 'DS', 'U', 'M']);
    expect(valueOf(CATALOG.get('resistor')!, { ohms: 4700 })).toBe('4.7k');
    expect(valueOf(CATALOG.get('led')!, { color: 'green' })).toBe('LED green');
    expect([220, 1000, 4700, 1_000_000, 10].map(formatOhms)).toEqual(['220', '1k', '4.7k', '1M', '10']);
  });
});
