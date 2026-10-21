/**
 * Everything to order and continue a board (BT58), as named files: the Gerbers, the drill file,
 * the BOM, the KiCad netlist and footprint library, and the layout itself (`.pcb.json`), each
 * under the board's name; `fabricationZip` bundles them.
 */

import type { PcbBoard } from '../board.ts';
import { bomCsv } from './bom.ts';
import { excellon } from './excellon.ts';
import { gerberFiles } from './gerber.ts';
import { kicadLibrary, kicadNetlist } from './kicad.ts';
import { zip } from './zip.ts';

export interface FabFile {
  name: string;
  text: string;
}

/** A file-name-safe version of a board name. */
export function fileBase(name: string): string {
  const base = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return base === '' ? 'board' : base.slice(0, 64);
}

export function fabricationFiles(board: PcbBoard): FabFile[] {
  const base = fileBase(board.pcb.name || board.project.name);
  return [
    ...gerberFiles(board).map((g) => ({ name: `${base}${g.suffix}`, text: g.text })),
    { name: `${base}-PTH.drl`, text: excellon(board) },
    { name: `${base}-bom.csv`, text: bomCsv(board) },
    { name: `${base}.net`, text: kicadNetlist(board) },
    ...kicadLibrary(board),
    { name: `${base}.pcb.json`, text: `${JSON.stringify(board.pcb, null, 2)}\n` },
  ];
}

export function fabricationZip(board: PcbBoard): Uint8Array {
  return zip(fabricationFiles(board).map((f) => ({ name: f.name, data: f.text })));
}
