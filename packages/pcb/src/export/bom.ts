/**
 * Bill of materials (BT58) as CSV (RFC 4180): one row per part type and value — the references
 * in order, the value, the footprint, the quantity, the catalog title.
 */

import { compareRefs, type PcbBoard } from '../board.ts';
import { valueOf } from '../footprints.ts';

/** A CSV field, quoted when it holds a comma, a quote or a line break. */
export function csvField(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function bomCsv(board: PcbBoard): string {
  const groups = new Map<string, { refs: string[]; value: string; footprint: string; title: string }>();
  for (const fp of board.placed) {
    const part = board.project.parts.find((p) => p.id === fp.doc.part);
    const value = valueOf(fp.def, part?.props ?? {});
    const key = `${fp.def.type}\u0000${value}`;
    const group = groups.get(key) ?? { refs: [], value, footprint: `Benchtop:${fp.footprint.name}`, title: fp.def.title };
    group.refs.push(fp.doc.ref);
    groups.set(key, group);
  }
  const rows = [...groups.values()].map((g) => ({ ...g, refs: g.refs.sort(compareRefs) })).sort((a, b) => compareRefs(a.refs[0], b.refs[0]));
  const lines = ['Reference,Value,Footprint,Quantity,Part'];
  for (const g of rows) lines.push([g.refs.join(' '), g.value, g.footprint, String(g.refs.length), g.title].map(csvField).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
