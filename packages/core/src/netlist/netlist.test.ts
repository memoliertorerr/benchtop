import { describe, expect, it } from 'vitest';
import type { PartInstance, ProjectDoc, Wire } from '../contracts/project.ts';
import { buildNetlist, type PartPinsSource } from './netlist.ts';

const STRIP_PINS = ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b3', 'b4', 'b5'];

/** A 2-pin resistor, a 1-pin probe and a 10-pin strip with two 5-pin buses. */
const source: PartPinsSource = {
  pins(type) {
    if (type === 'resistor') return ['1', '2'];
    if (type === 'probe') return ['p'];
    if (type === 'strip') return STRIP_PINS;
    if (type === 'quad') return ['1', '2', '3', '4'];
    return undefined;
  },
  buses(type) {
    if (type === 'strip') return [STRIP_PINS.slice(0, 5), STRIP_PINS.slice(5)];
    return [];
  },
};

function part(id: string, type: string): PartInstance {
  return { id, type, x: 0, y: 0, rotation: 0, props: {} };
}

let wireCount = 0;
function wire(from: string, to: string): Wire {
  const [fp, fn] = from.split(':') as [string, string];
  const [tp, tn] = to.split(':') as [string, string];
  return { id: `w${wireCount++}`, from: { part: fp, pin: fn }, to: { part: tp, pin: tn }, waypoints: [], color: 'green' };
}

function doc(parts: PartInstance[], wires: Wire[]): ProjectDoc {
  return { format: 1, name: 'netlist test', parts, wires, firmware: {} };
}

describe('buildNetlist', () => {
  it('joins A→B and B→C into one net of 3 pins', () => {
    const n = buildNetlist(
      doc([part('a', 'probe'), part('b', 'probe'), part('c', 'probe')], [wire('a:p', 'b:p'), wire('b:p', 'c:p')]),
      source,
    );
    expect(n.netCount).toBe(1);
    expect(n.pinsOfNet(n.netOf('a', 'p'))).toEqual([
      { part: 'a', pin: 'p' },
      { part: 'b', pin: 'p' },
      { part: 'c', pin: 'p' },
    ]);
  });

  it('merges a part bus: a 5-hole strip plus two wires into it is one net', () => {
    const n = buildNetlist(
      doc([part('s', 'strip'), part('x', 'probe'), part('y', 'probe')], [wire('x:p', 's:a1'), wire('y:p', 's:a4')]),
      source,
    );
    const net = n.netOf('s', 'a3');
    expect(n.netOf('x', 'p')).toBe(net);
    expect(n.netOf('y', 'p')).toBe(net);
    expect(n.pinsOfNet(net)).toHaveLength(7);
    // The other half of the strip is its own bus, untouched by the wires.
    expect(n.netOf('s', 'b1')).not.toBe(net);
    expect(n.pinsOfNet(n.netOf('s', 'b1')).map((r) => r.pin)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
    expect(n.netCount).toBe(2);
  });

  it("keeps a resistor's two pins on separate nets: links are not buses", () => {
    const n = buildNetlist(
      doc([part('r1', 'resistor'), part('x', 'probe'), part('y', 'probe')], [wire('x:p', 'r1:1'), wire('r1:2', 'y:p')]),
      source,
    );
    expect(n.netOf('r1', '1')).not.toBe(n.netOf('r1', '2'));
    expect(n.netOf('x', 'p')).toBe(n.netOf('r1', '1'));
    expect(n.netOf('y', 'p')).toBe(n.netOf('r1', '2'));
    expect(n.netCount).toBe(2);
  });

  it('gives every unconnected pin its own net, numbered in pin order', () => {
    const n = buildNetlist(doc([part('r1', 'resistor'), part('x', 'probe')], []), source);
    expect(n.netCount).toBe(3);
    expect([n.netOf('r1', '1'), n.netOf('r1', '2'), n.netOf('x', 'p')]).toEqual([0, 1, 2]);
    for (let net = 0; net < 3; net++) expect(n.pinsOfNet(net)).toHaveLength(1);
  });

  it('lists wire ends naming an unknown pin or part as unresolved instead of throwing', () => {
    const d = doc(
      [part('r1', 'resistor'), part('x', 'probe'), part('m', 'mystery')],
      [wire('x:p', 'r1:3'), wire('m:1', 'r1:1'), wire('ghost:p', 'x:p')],
    );
    const n = buildNetlist(d, source);
    expect(n.unresolved).toEqual([
      { wire: d.wires[0].id, end: 'to', ref: { part: 'r1', pin: '3' } },
      { wire: d.wires[1].id, end: 'from', ref: { part: 'm', pin: '1' } },
      { wire: d.wires[2].id, end: 'from', ref: { part: 'ghost', pin: 'p' } },
    ]);
    expect(n.unknownParts).toEqual(['m']);
    expect(n.netCount).toBe(3);
    expect(n.netOf('r1', '3')).toBe(-1);
    expect(n.netOf('m', '1')).toBe(-1);
    expect(n.pinsOfNet(-1)).toEqual([]);
    expect(n.pinsOfNet(99)).toEqual([]);
  });

  it('builds 2,000 parts × 4 pins + 4,000 wires in under 200 ms', () => {
    const parts: PartInstance[] = [];
    for (let i = 0; i < 2000; i++) parts.push(part(`p${i}`, 'quad'));
    const wires: Wire[] = [];
    // Deterministic pseudo-random wiring (LCG), so the run is repeatable.
    let seed = 12345;
    const next = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let i = 0; i < 4000; i++) {
      wires.push(wire(`p${next() % 2000}:${(next() % 4) + 1}`, `p${next() % 2000}:${(next() % 4) + 1}`));
    }
    const d = doc(parts, wires);
    let start = performance.now();
    buildNetlist(d, source);
    const coldMs = performance.now() - start;
    start = performance.now();
    const n = buildNetlist(d, source);
    const ms = performance.now() - start;
    console.info(
      `netlist: 2000 parts x 4 pins + 4000 wires: ${coldMs.toFixed(2)} ms cold, ${ms.toFixed(2)} ms warm (${n.netCount} nets)`,
    );
    expect(coldMs).toBeLessThan(200);
    expect(ms).toBeLessThan(200);
    // Sanity: every pin landed on a net, and the nets partition the 8,000 pins.
    let total = 0;
    for (let net = 0; net < n.netCount; net++) total += n.pinsOfNet(net).length;
    expect(total).toBe(8000);
    expect(n.unresolved).toEqual([]);
  });
});
