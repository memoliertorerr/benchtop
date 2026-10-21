import type { PartInstance, ProjectDoc } from '@benchtop/core';
import { benchEnvParts } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../core/src/firmware/fixtures.test-helper.ts';
import { boardPinName, compareRefs, PcbBoard } from './board.ts';
import { connectivity } from './connectivity.ts';
import { parsePcb, type PcbDoc } from './doc.ts';
import { ratsnest } from './ratsnest.ts';
import { outlineAround, reconcilePcb, seedPcb } from './seed.ts';

const blink = (): ProjectDoc => JSON.parse(readFixtureText('fixtures/projects/blink-led.json')) as ProjectDoc;

describe('a PCB from a bench project (BT57)', () => {
  it('blink-led: the Uno as a shield, the resistor and LED; the breadboard and wires become nets', () => {
    const project = blink();
    const pcb = seedPcb(project, benchEnvParts);
    const board = new PcbBoard(project, pcb, benchEnvParts);
    expect(board.stale).toEqual([]);
    expect(pcb.footprints.map((f) => f.ref).sort(compareRefs)).toEqual(['A1', 'D1', 'R1']);
    expect(project.parts.some((p) => p.type.startsWith('breadboard'))).toBe(true);
    const names = board.routable.map((n) => n.name).sort();
    // D13 → resistor, resistor → LED anode, LED cathode → GND.
    expect(names).toContain('D13');
    expect(names).toContain('GND');
    const between = board.routable.find((n) => n.name.startsWith('Net-('));
    expect(between).toBeDefined();
    expect(new Set(between!.pads.map((i) => board.pads[i].ref))).toEqual(new Set(['D1', 'R1']));
    expect(between!.pads.map((i) => board.pads[i].pin)).toContain('A');
    // Seeded where the bench had the parts, inside an outline 3 mm around them.
    for (const f of pcb.footprints) {
      const part = project.parts.find((p) => p.id === f.part)!;
      const def = benchEnvParts(part.type)!;
      expect(f.x).toBeCloseTo(part.x + def.size.w / 2, 2);
      expect(f.y).toBeCloseTo(part.y + def.size.h / 2, 2);
    }
    expect(pcb.outline).toHaveLength(4);
    for (const fp of board.placed) {
      expect(fp.courtyard.x0).toBeGreaterThanOrEqual(pcb.outline[0].x + 3 - 1e-9);
      expect(fp.courtyard.y1).toBeLessThanOrEqual(pcb.outline[2].y - 3 + 1e-9);
    }
  });

  it('names nets after board pins, supplies first, else after the first pad', () => {
    expect(['GND.2', '13', 'A0', '5V', '3.3V'].map(boardPinName)).toEqual(['GND', 'D13', 'A0', '5V', '3.3V']);
  });

  it('reconciles with an edited bench: removed parts go, new ones land right of the board, refs stay', () => {
    const project = blink();
    const pcb = seedPcb(project, benchEnvParts);
    const r1 = pcb.footprints.find((f) => f.ref === 'R1')!;
    const moved: PcbDoc = { ...pcb, footprints: pcb.footprints.map((f) => (f === r1 ? { ...f, x: f.x + 7 } : f)) };
    expect(reconcilePcb(moved, project, benchEnvParts)).toBe(moved);
    const led = project.parts.find((p) => p.type === 'led')!;
    const edited: ProjectDoc = {
      ...project,
      parts: [...project.parts.filter((p) => p !== led), { id: 'r9', type: 'resistor', x: 0, y: 0, rotation: 0, props: {} } satisfies PartInstance],
    };
    const next = reconcilePcb(moved, edited, benchEnvParts);
    expect(next.footprints.map((f) => f.ref).sort(compareRefs)).toEqual(['A1', 'R1', 'R2']);
    expect(next.footprints.find((f) => f.ref === 'R1')!.x).toBe(r1.x + 7);
    const r2 = next.footprints.find((f) => f.ref === 'R2')!;
    expect(r2.x).toBeGreaterThan(Math.max(...moved.outline.map((p) => p.x)));
    expect(next.outline).toEqual(moved.outline);
    expect(outlineAround(next.footprints, edited, benchEnvParts)[1].x).toBeGreaterThan(moved.outline[1].x);
  });

  it('routes: a trace between two pads joins their islands; the ratsnest shrinks', () => {
    const project = blink();
    const pcb = seedPcb(project, benchEnvParts);
    const before = new PcbBoard(project, pcb, benchEnvParts);
    const lines = ratsnest(before, connectivity(before));
    expect(lines.length).toBe(before.routable.reduce((n, net) => n + new Set(net.pads.map((i) => before.pads[i].footprint + ':' + before.pads[i].number)).size - 1, 0));
    const { a, b } = lines[0];
    const pa = before.pads[a];
    const pb = before.pads[b];
    const routed: PcbDoc = { ...pcb, traces: [{ id: 't1', layer: 'F', width: 0.4, points: [{ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }] }] };
    const after = new PcbBoard(project, routed, benchEnvParts);
    expect(ratsnest(after, connectivity(after)).length).toBe(lines.length - 1);
  });
});

describe('parsePcb', () => {
  it('round-trips a seeded PCB and refuses bad documents with JSON Pointer paths', () => {
    const pcb = seedPcb(blink(), benchEnvParts);
    const ok = parsePcb(JSON.parse(JSON.stringify(pcb)));
    expect(ok).toEqual({ ok: true, doc: pcb });
    const bad = parsePcb({
      format: 2,
      name: 'x',
      outline: [{ x: 0, y: 0 }],
      footprints: [{ part: 'r1', ref: 'R1', x: 0, y: 0, rotation: 45 }, { part: 'r1', ref: 'R1', x: Infinity, y: 0, rotation: 0 }],
      traces: [{ id: 't1', layer: 'X', width: 0, points: [{ x: 0, y: 0 }] }],
      vias: [{ id: 't1', x: 0, y: 0, drill: 0.5, diameter: 0.4 }],
      rules: { clearance: -1 },
      extra: true,
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.map((e) => e.path)).toEqual([
      '/format',
      '/outline',
      '/footprints/0/rotation',
      '/footprints/1/ref',
      '/footprints/1/part',
      '/footprints/1/x',
      '/traces/0/layer',
      '/traces/0/points',
      '/traces/0/width',
      '/vias/0/id',
      '/vias/0/diameter',
      '/rules/clearance',
    ]);
    expect(parsePcb('nope')).toEqual({ ok: false, errors: [{ path: '', message: 'must be an object' }] });
    expect(parsePcb({ format: 1, name: 'x', outline: [], footprints: new Array(2001).fill({}), traces: [], vias: [] }).ok).toBe(false);
  });
});
