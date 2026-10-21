/**
 * The ratsnest (BT57): for each net, the connections still missing — a minimum spanning tree
 * over the net's copper islands, each edge between the two closest pads of the islands it joins
 * (Prim's algorithm over islands; a net's pads number in the tens, so O(p²) is fine).
 */

import type { PcbBoard } from './board.ts';
import type { Connectivity } from './connectivity.ts';

export interface RatsnestLine {
  net: number;
  /** Pad indexes (board.pads). */
  a: number;
  b: number;
}

export function ratsnest(board: PcbBoard, conn: Connectivity): RatsnestLine[] {
  const lines: RatsnestLine[] = [];
  for (const net of board.nets) {
    // Pads grouped by island.
    const groups = new Map<number, number[]>();
    for (const pad of net.pads) {
      const island = conn.padIsland[pad];
      const list = groups.get(island) ?? [];
      list.push(pad);
      groups.set(island, list);
    }
    const islands = [...groups.values()];
    if (islands.length < 2) continue;
    const inTree = new Array<boolean>(islands.length).fill(false);
    inTree[0] = true;
    // Best known edge from the tree to each island.
    const best = islands.map(() => ({ d: Infinity, a: -1, b: -1 }));
    const relax = (from: number): void => {
      for (let k = 0; k < islands.length; k++) {
        if (inTree[k]) continue;
        for (const a of islands[from]) {
          for (const b of islands[k]) {
            const pa = board.pads[a];
            const pb = board.pads[b];
            const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
            if (d < best[k].d) best[k] = { d, a, b };
          }
        }
      }
    };
    relax(0);
    for (let added = 1; added < islands.length; added++) {
      let next = -1;
      for (let k = 0; k < islands.length; k++) if (!inTree[k] && (next < 0 || best[k].d < best[next].d)) next = k;
      inTree[next] = true;
      lines.push({ net: net.id, a: best[next].a, b: best[next].b });
      relax(next);
    }
  }
  return lines;
}
