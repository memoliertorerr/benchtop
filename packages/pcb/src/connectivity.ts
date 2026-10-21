/**
 * Copper connectivity (BT57): which pads, vias and trace segments touch. Through-hole pads and
 * vias are on both layers; a segment on its own. Two items on a shared layer whose copper
 * touches or overlaps join one island (union-find); a footprint's pads with one number (pins
 * shorted inside the part) start joined. Broad phase: items sorted by their bounding box's left
 * edge and swept, so a dense board costs about n·log n plus the real neighbours.
 */

import type { PcbBoard } from './board.ts';
import type { Layer } from './doc.ts';
import { type Box, type Shape, shapeBox, shapeDistance } from './geometry.ts';

export type CopperKind = 'pad' | 'via' | 'segment';

export interface Copper {
  kind: CopperKind;
  /** pad: index into board.pads; via: into pcb.vias; segment: into pcb.traces. */
  index: number;
  /** segment: which segment of its trace (points[seg] → points[seg + 1]). */
  seg: number;
  /** null = both layers (pads, vias). */
  layer: Layer | null;
  shape: Shape;
  box: Box;
}

/** A pad's copper: a circle or an oval as a capsule, a square pad as a rectangle. */
function padShape(x: number, y: number, w: number, h: number, shape: string): Shape {
  if (shape === 'rect') return { k: 'rect', x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
  if (w === h || shape === 'circle') return { k: 'cap', x1: x, y1: y, x2: x, y2: y, r: Math.min(w, h) / 2 };
  const r = Math.min(w, h) / 2;
  return w > h ? { k: 'cap', x1: x - w / 2 + r, y1: y, x2: x + w / 2 - r, y2: y, r } : { k: 'cap', x1: x, y1: y - h / 2 + r, x2: x, y2: y + h / 2 - r, r };
}

/** Every copper item on the board. */
export function copperItems(board: PcbBoard): Copper[] {
  const items: Copper[] = [];
  const add = (kind: CopperKind, index: number, seg: number, layer: Layer | null, shape: Shape): void => {
    items.push({ kind, index, seg, layer, shape, box: shapeBox(shape) });
  };
  board.pads.forEach((p, i) => add('pad', i, 0, null, padShape(p.x, p.y, p.w, p.h, p.shape)));
  board.pcb.vias.forEach((v, i) => add('via', i, 0, null, { k: 'cap', x1: v.x, y1: v.y, x2: v.x, y2: v.y, r: v.diameter / 2 }));
  board.pcb.traces.forEach((t, i) => {
    for (let s = 0; s + 1 < t.points.length; s++) {
      const a = t.points[s];
      const b = t.points[s + 1];
      add('segment', i, s, t.layer, { k: 'cap', x1: a.x, y1: a.y, x2: b.x, y2: b.y, r: t.width / 2 });
    }
  });
  return items;
}

/** Calls `visit(i, j)` for every pair of items whose boxes, grown by `margin`, overlap. */
export function sweepPairs(items: readonly Copper[], margin: number, visit: (i: number, j: number) => void): void {
  const order = items.map((_, i) => i).sort((a, b) => items[a].box.x0 - items[b].box.x0);
  const active: number[] = [];
  for (const i of order) {
    const bi = items[i].box;
    // Drop the items that end left of this one's start.
    let w = 0;
    for (const j of active) if (items[j].box.x1 + margin >= bi.x0) active[w++] = j;
    active.length = w;
    for (const j of active) {
      const bj = items[j].box;
      if (bj.y0 - margin <= bi.y1 && bi.y0 - margin <= bj.y1) visit(j, i);
    }
    active.push(i);
  }
}

/** True when two items share a layer (pads and vias are on both). */
export function shareLayer(a: Copper, b: Copper): boolean {
  return a.layer === null || b.layer === null || a.layer === b.layer;
}

export interface Connectivity {
  items: Copper[];
  /** Island id per item. */
  island: Int32Array;
  /** Per island, the nets of the pads in it (sorted). */
  islandNets: number[][];
  islandCount: number;
  /** Island of each pad (by pad index). */
  padIsland: Int32Array;
}

class UnionFind {
  private readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n).map((_, i) => i);
  }
  find(i: number): number {
    let r = i;
    while (this.parent[r] !== r) r = this.parent[r];
    while (this.parent[i] !== r) {
      const next = this.parent[i];
      this.parent[i] = r;
      i = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
  }
}

/** The board's copper islands. */
export function connectivity(board: PcbBoard): Connectivity {
  const items = copperItems(board);
  const uf = new UnionFind(items.length);
  // Pads with one number on one footprint are shorted inside the part.
  const firstPad = new Map<string, number>();
  items.forEach((item, i) => {
    if (item.kind !== 'pad') return;
    const pad = board.pads[item.index];
    const key = `${pad.footprint}:${pad.number}`;
    const first = firstPad.get(key);
    if (first === undefined) firstPad.set(key, i);
    else uf.union(first, i);
  });
  sweepPairs(items, 0, (i, j) => {
    if (shareLayer(items[i], items[j]) && shapeDistance(items[i].shape, items[j].shape) <= 1e-9) uf.union(i, j);
  });
  const island = new Int32Array(items.length);
  const rootIsland = new Map<number, number>();
  items.forEach((_, i) => {
    const root = uf.find(i);
    let id = rootIsland.get(root);
    if (id === undefined) rootIsland.set(root, (id = rootIsland.size));
    island[i] = id;
  });
  const nets: Set<number>[] = Array.from({ length: rootIsland.size }, () => new Set<number>());
  const padIsland = new Int32Array(board.pads.length).fill(-1);
  items.forEach((item, i) => {
    if (item.kind !== 'pad') return;
    padIsland[item.index] = island[i];
    const net = board.pads[item.index].net;
    if (net >= 0) nets[island[i]].add(net);
  });
  return { items, island, islandNets: nets.map((s) => [...s].sort((a, b) => a - b)), islandCount: rootIsland.size, padIsland };
}
