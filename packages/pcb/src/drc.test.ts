import type { ProjectDoc } from '@benchtop/core';
import { benchEnvParts } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { PcbBoard } from './board.ts';
import { DEFAULT_RULES, type PcbDoc, type PcbTrace, type PcbVia } from './doc.ts';
import { drc } from './drc.ts';

// BT57: each rule on a hand-built board — two resistors whose pads R1-2 and R2-1 are one net
// (a wire on the bench) — passing and failing, with what it names.

const project: ProjectDoc = {
  format: 1,
  name: 'two resistors',
  parts: [
    { id: 'r1', type: 'resistor', x: 0, y: 0, rotation: 0, props: {} },
    { id: 'r2', type: 'resistor', x: 0, y: 20, rotation: 0, props: {} },
  ],
  wires: [{ id: 'w1', from: { part: 'r1', pin: '2' }, to: { part: 'r2', pin: '1' }, waypoints: [], color: 'green' }],
  firmware: {},
};

/** R1 at (10, 10), R2 at (10, 20): pads at x = 4.92 and 15.08. */
function pcb(extra: { traces?: PcbTrace[]; vias?: PcbVia[]; r2?: { x: number; y: number } } = {}): PcbDoc {
  return {
    format: 1,
    name: 'two resistors',
    outline: [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 30 },
      { x: 0, y: 30 },
    ],
    footprints: [
      { part: 'r1', ref: 'R1', x: 10, y: 10, rotation: 0 },
      { part: 'r2', ref: 'R2', x: extra.r2?.x ?? 10, y: extra.r2?.y ?? 20, rotation: 0 },
    ],
    traces: extra.traces ?? [],
    vias: extra.vias ?? [],
    rules: { ...DEFAULT_RULES },
  };
}

const route: PcbTrace = {
  id: 't1',
  layer: 'F',
  width: 0.4,
  points: [
    { x: 15.08, y: 10 },
    { x: 15.08, y: 15 },
    { x: 4.92, y: 15 },
    { x: 4.92, y: 20 },
  ],
};

const check = (doc: PcbDoc) => drc(new PcbBoard(project, doc, benchEnvParts));
const codes = (doc: PcbDoc): string[] => check(doc).violations.map((v) => v.code);

describe('DRC', () => {
  it('a routed board passes; an unrouted net is an error naming it', () => {
    expect(check(pcb({ traces: [route] }))).toEqual({ violations: [], unrouted: 0 });
    const open = check(pcb());
    expect(open.unrouted).toBe(1);
    expect(open.violations).toEqual([
      { severity: 'error', code: 'unrouted', message: 'Net Net-(R1-Pad2): 1 connection missing.', at: { x: 15.08, y: 10 }, items: ['Net-(R1-Pad2)'] },
    ]);
  });

  it('clearance: a floating track 0.1 mm from two pads of other nets', () => {
    // On the back layer, so it crosses t1 (front) without touching it — but not the through-hole pads.
    const near: PcbTrace = { id: 't2', layer: 'B', width: 0.4, points: [{ x: 3, y: 11.1 }, { x: 17, y: 11.1 }] };
    const v = check(pcb({ traces: [route, near] })).violations;
    expect(v.map((x) => [x.code, x.items])).toEqual([
      ['clearance', ['pad R1-1', 'track t2']],
      ['clearance', ['pad R1-2', 'track t2']],
    ]);
    expect(v[0].message).toBe('pad R1-1 and track t2 are 0.1 mm apart (clearance 0.2 mm).');
    // 0.3 mm further away it passes.
    expect(codes(pcb({ traces: [route, { ...near, points: near.points.map((p) => ({ x: p.x, y: p.y + 0.3 })) }] }))).toEqual([]);
    // On the front layer it would touch t1 and join its net: then only R1-1 is too close.
    expect(check(pcb({ traces: [route, { ...near, layer: 'F' }] })).violations.map((x) => x.items)).toEqual([['pad R1-1', 'track t2']]);
  });

  it('a track joining two nets is a short', () => {
    const across: PcbTrace = { id: 't3', layer: 'B', width: 0.4, points: [{ x: 4.92, y: 10 }, { x: 15.08, y: 10 }] };
    const v = check(pcb({ traces: [route, across] })).violations;
    expect(v.map((x) => x.code)).toEqual(['short']);
    expect(v[0].message).toBe('Copper joins nets Net-(R1-Pad1) and Net-(R1-Pad2).');
  });

  it('width, drill and annular ring', () => {
    expect(codes(pcb({ traces: [{ ...route, width: 0.1 }] }))).toEqual(['track-width']);
    const via: PcbVia = { id: 'v1', x: 25, y: 25, drill: 0.2, diameter: 0.4 };
    expect(check(pcb({ traces: [route], vias: [via] })).violations.map((x) => x.message)).toEqual([
      'Via v1 has a 0.2 mm drill (minimum 0.3 mm).',
      'Via v1 has a 0.1 mm ring (minimum 0.15 mm).',
    ]);
  });

  it('the board edge: copper too close, copper outside, a footprint outside, no outline', () => {
    const edgeVia: PcbVia = { id: 'v1', x: 0.6, y: 25, drill: 0.4, diameter: 0.8 };
    expect(check(pcb({ traces: [route], vias: [edgeVia] })).violations.map((x) => x.message)).toEqual(['via v1 is 0.2 mm from the board edge (minimum 0.5 mm).']);
    const outside: PcbTrace = { id: 't4', layer: 'F', width: 0.4, points: [{ x: 25, y: 25 }, { x: 35, y: 25 }] };
    expect(codes(pcb({ traces: [route, outside] }))).toEqual(['outside-board']);
    expect(codes(pcb({ r2: { x: 40, y: 40 } }))).toContain('outside-board');
    expect(codes({ ...pcb({ traces: [route] }), outline: [] })).toEqual(['no-outline']);
  });

  it('overlapping courtyards are a warning', () => {
    const v = check(pcb({ r2: { x: 12, y: 12.5 } })).violations.filter((x) => x.code === 'courtyard-overlap');
    expect(v).toEqual([{ severity: 'warning', code: 'courtyard-overlap', message: 'R1 and R2 overlap.', at: { x: 11, y: 11.25 }, items: ['R1', 'R2'] }]);
  });
});
