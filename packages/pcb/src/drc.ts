/**
 * Design rule check (BT57). Errors: copper of different nets closer than the clearance on a
 * layer they share, copper joining two nets (a short), traces thinner than the minimum width,
 * drills and annular rings below the minimum, copper nearer the board edge than the edge
 * clearance or outside the board, a footprint outside the board, a missing outline, and nets
 * not fully routed. Warnings: courtyards that overlap (a board's — a shield, a module carrier —
 * is left out: parts sit within it by design). Each names its items and a point to look
 * at. Copper on no net (a floating trace) is its own net: it must keep clear of the others.
 */

import type { PcbBoard } from './board.ts';
import { connectivity, type Copper, shareLayer, sweepPairs } from './connectivity.ts';
import { type Box, pointInPolygon, segmentSegment, shapeDistance } from './geometry.ts';
import { ratsnest } from './ratsnest.ts';

export interface DrcViolation {
  severity: 'error' | 'warning';
  code:
    | 'clearance'
    | 'short'
    | 'track-width'
    | 'drill'
    | 'annular-ring'
    | 'edge-clearance'
    | 'outside-board'
    | 'no-outline'
    | 'unrouted'
    | 'courtyard-overlap';
  message: string;
  /** Where to look, mm. */
  at: { x: number; y: number };
  /** References, net names, "track t3", "via v2" — what the message is about. */
  items: string[];
}

/** At most this many violations of one code are listed (the rest are counted in the last). */
export const MAX_PER_CODE = 50;

const fmt = (v: number): string => `${Number(v.toFixed(3))} mm`;
const KIND_RANK: Readonly<Record<Copper['kind'], number>> = { pad: 0, via: 1, segment: 2 };

export interface DrcResult {
  violations: DrcViolation[];
  /** Missing connections per routable net (0 = routed). */
  unrouted: number;
}

export function drc(board: PcbBoard): DrcResult {
  const { pcb } = board;
  const rules = pcb.rules;
  const out: DrcViolation[] = [];
  const counts = new Map<string, number>();
  const report = (v: DrcViolation): void => {
    const n = (counts.get(v.code) ?? 0) + 1;
    counts.set(v.code, n);
    if (n <= MAX_PER_CODE) out.push(v);
  };
  const conn = connectivity(board);
  const { items, island, islandNets } = conn;
  const netName = (net: number): string => board.nets[net]?.name ?? '?';
  const describe = (c: Copper): string => {
    if (c.kind === 'pad') {
      const p = board.pads[c.index];
      return `pad ${p.ref}-${p.number}`;
    }
    if (c.kind === 'via') return `via ${pcb.vias[c.index].id}`;
    return `track ${pcb.traces[c.index].id}`;
  };
  const centre = (b: Box): { x: number; y: number } => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });

  // Shorts: an island holding pads of two or more nets.
  islandNets.forEach((nets, k) => {
    if (nets.length < 2) return;
    const item = items.find((_, i) => island[i] === k && items[i].kind !== 'pad') ?? items.find((_, i) => island[i] === k)!;
    report({ severity: 'error', code: 'short', message: `Copper joins nets ${nets.map(netName).join(' and ')}.`, at: centre(item.box), items: nets.map(netName) });
  });

  // Each item's net for clearance: its island's single net, else an island-unique negative id.
  const netOfItem = (i: number): number => {
    const nets = islandNets[island[i]];
    return nets.length === 1 ? nets[0] : -1 - island[i];
  };

  // Clearance between items of different nets on a shared layer.
  sweepPairs(items, rules.clearance, (i, j) => {
    const a = items[i];
    const b = items[j];
    if (island[i] === island[j] || !shareLayer(a, b)) return;
    if (netOfItem(i) === netOfItem(j)) return;
    const gap = shapeDistance(a.shape, b.shape);
    if (gap >= rules.clearance - 1e-9) return;
    // Name the pair in a fixed order (pads, vias, tracks; then by name), whatever the sweep's.
    const [first, second] = KIND_RANK[a.kind] < KIND_RANK[b.kind] || (a.kind === b.kind && describe(a) <= describe(b)) ? [a, b] : [b, a];
    const where = centre({ x0: Math.max(a.box.x0, b.box.x0), y0: Math.max(a.box.y0, b.box.y0), x1: Math.min(a.box.x1, b.box.x1), y1: Math.min(a.box.y1, b.box.y1) });
    report({
      severity: 'error',
      code: 'clearance',
      message: `${describe(first)} and ${describe(second)} are ${gap <= 0 ? 'touching' : fmt(gap) + ' apart'} (clearance ${fmt(rules.clearance)}).`,
      at: where,
      items: [describe(first), describe(second)],
    });
  });

  // Widths, drills, rings.
  pcb.traces.forEach((t) => {
    if (t.width < rules.minWidth - 1e-9) report({ severity: 'error', code: 'track-width', message: `Track ${t.id} is ${fmt(t.width)} wide (minimum ${fmt(rules.minWidth)}).`, at: t.points[0], items: [`track ${t.id}`] });
  });
  pcb.vias.forEach((v) => {
    if (v.drill < rules.minDrill - 1e-9) report({ severity: 'error', code: 'drill', message: `Via ${v.id} has a ${fmt(v.drill)} drill (minimum ${fmt(rules.minDrill)}).`, at: v, items: [`via ${v.id}`] });
    if ((v.diameter - v.drill) / 2 < rules.minAnnular - 1e-9) report({ severity: 'error', code: 'annular-ring', message: `Via ${v.id} has a ${fmt((v.diameter - v.drill) / 2)} ring (minimum ${fmt(rules.minAnnular)}).`, at: v, items: [`via ${v.id}`] });
  });

  // The board edge.
  const outline = pcb.outline;
  if (outline.length < 3) {
    report({ severity: 'error', code: 'no-outline', message: 'The board has no outline.', at: { x: 0, y: 0 }, items: [] });
  } else {
    items.forEach((c) => {
      const s = c.shape;
      const pts = s.k === 'cap' ? [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }] : [{ x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 }];
      if (pts.some((p) => !pointInPolygon(p.x, p.y, outline))) {
        if (c.kind !== 'pad') report({ severity: 'error', code: 'outside-board', message: `${describe(c)} is outside the board.`, at: pts[0], items: [describe(c)] });
        return;
      }
      let gap = Infinity;
      for (let k = 0; k < outline.length; k++) {
        const p = outline[k];
        const q = outline[(k + 1) % outline.length];
        gap = Math.min(gap, edgeGap(c, p.x, p.y, q.x, q.y));
      }
      if (gap < rules.edgeClearance - 1e-9) report({ severity: 'error', code: 'edge-clearance', message: `${describe(c)} is ${fmt(Math.max(0, gap))} from the board edge (minimum ${fmt(rules.edgeClearance)}).`, at: centre(c.box), items: [describe(c)] });
    });
    const outsideFootprints = new Set<number>();
    for (const p of board.pads) if (!pointInPolygon(p.x, p.y, outline)) outsideFootprints.add(p.footprint);
    for (const f of [...outsideFootprints].sort((a, b) => a - b)) {
      const fp = board.placed[f];
      report({ severity: 'error', code: 'outside-board', message: `${fp.doc.ref} is outside the board.`, at: { x: fp.doc.x, y: fp.doc.y }, items: [fp.doc.ref] });
    }
  }

  // Courtyards (swept by their left edges).
  const byLeft = board.placed.map((_, i) => i).sort((p, q) => board.placed[p].courtyard.x0 - board.placed[q].courtyard.x0);
  for (let m = 0; m < byLeft.length; m++) {
    const i0 = byLeft[m];
    for (let n = m + 1; n < byLeft.length; n++) {
      const j0 = byLeft[n];
      if (board.placed[j0].courtyard.x0 >= board.placed[i0].courtyard.x1) break;
      const [i, j] = i0 < j0 ? [i0, j0] : [j0, i0];
      // A board's footprint is a shield or a module carrier: parts sit within it by design.
      if (board.placed[i].def.board !== undefined || board.placed[j].def.board !== undefined) continue;
      const a = board.placed[i].courtyard;
      const b = board.placed[j].courtyard;
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) {
        report({
          severity: 'warning',
          code: 'courtyard-overlap',
          message: `${board.placed[i].doc.ref} and ${board.placed[j].doc.ref} overlap.`,
          at: centre({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) }),
          items: [board.placed[i].doc.ref, board.placed[j].doc.ref],
        });
      }
    }
  }

  // Unrouted nets.
  const lines = ratsnest(board, conn);
  const missing = new Map<number, number>();
  for (const l of lines) missing.set(l.net, (missing.get(l.net) ?? 0) + 1);
  for (const [net, n] of missing) {
    const first = lines.find((l) => l.net === net)!;
    const pa = board.pads[first.a];
    report({ severity: 'error', code: 'unrouted', message: `Net ${netName(net)}: ${n} connection${n === 1 ? '' : 's'} missing.`, at: { x: pa.x, y: pa.y }, items: [netName(net)] });
  }

  // Counted overflow.
  for (const [code, n] of counts) {
    if (n <= MAX_PER_CODE) continue;
    const last = out.filter((v) => v.code === code).at(-1)!;
    last.message += ` (and ${n - MAX_PER_CODE} more like it)`;
  }
  return { violations: out, unrouted: lines.length };
}

/** Distance from an item's copper to an edge segment pq. */
function edgeGap(c: Copper, px: number, py: number, qx: number, qy: number): number {
  const s = c.shape;
  if (s.k === 'cap') return segmentSegment(s.x1, s.y1, s.x2, s.y2, px, py, qx, qy) - s.r;
  // A rectangle: its nearest corner or edge to the segment.
  return shapeDistance(s, { k: 'cap', x1: px, y1: py, x2: qx, y2: qy, r: 0 });
}
