/**
 * Excellon drill file (BT58): every plated hole — pads and vias — in one file, tools by
 * diameter (smallest first), metric with decimal coordinates, y negated like the Gerbers.
 */

import type { PcbBoard } from '../board.ts';

const mm = (v: number): string => String(Number(v.toFixed(4)));

export interface Hole {
  x: number;
  y: number;
  d: number;
}

/** Every plated hole on the board. */
export function holes(board: PcbBoard): Hole[] {
  return [...board.pads.map((p) => ({ x: p.x, y: p.y, d: p.drill })), ...board.pcb.vias.map((v) => ({ x: v.x, y: v.y, d: v.drill }))];
}

export function excellon(board: PcbBoard): string {
  const all = holes(board);
  const sizes = [...new Set(all.map((h) => Number(h.d.toFixed(4))))].sort((a, b) => a - b);
  const lines = ['M48', '; DRILL file for a Benchtop PCB (plated holes)', '; FORMAT={-:-/ absolute / metric / decimal}', 'FMAT,2', 'METRIC'];
  sizes.forEach((d, i) => lines.push(`T${i + 1}C${mm(d)}`));
  lines.push('%', 'G90', 'G05');
  sizes.forEach((d, i) => {
    lines.push(`T${i + 1}`);
    for (const h of all) if (Number(h.d.toFixed(4)) === d) lines.push(`X${mm(h.x)}Y${mm(-h.y)}`);
  });
  lines.push('M30', '');
  return lines.join('\n');
}
