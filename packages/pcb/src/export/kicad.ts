/**
 * KiCad exports (BT58): a netlist (the s-expression `(export (version "E") …)` KiCad's PCB editor
 * imports) whose components name footprints in a `Benchtop` library, and that library — one
 * `.kicad_mod` per footprint used — so the import finds every footprint with the pad numbers
 * the netlist uses. KiCad's coordinates are mm with y down, as here.
 */

import { compareRefs, type PcbBoard } from '../board.ts';
import type { Footprint } from '../footprints.ts';
import { valueOf } from '../footprints.ts';

/** A KiCad s-expression string literal. */
export function sx(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

const n = (v: number): string => String(Number(v.toFixed(4)));

export function kicadNetlist(board: PcbBoard): string {
  const out: string[] = ['(export (version "E")', `  (design (source ${sx(board.project.name)}) (tool "Benchtop"))`, '  (components'];
  const placed = [...board.placed].sort((a, b) => compareRefs(a.doc.ref, b.doc.ref));
  for (const fp of placed) {
    const part = board.project.parts.find((p) => p.id === fp.doc.part);
    out.push(
      `    (comp (ref ${sx(fp.doc.ref)})`,
      `      (value ${sx(valueOf(fp.def, part?.props ?? {}))})`,
      `      (footprint ${sx(`Benchtop:${fp.footprint.name}`)})`,
      `      (libsource (lib "Benchtop") (part ${sx(fp.def.type)}) (description ${sx(fp.def.title)}))`,
      `      (property (name "Bench part") (value ${sx(fp.doc.part)})))`,
    );
  }
  out.push('  )', '  (nets');
  board.nets.forEach((net, i) => {
    // One node per distinct pad number of a footprint (a bus's pads share one).
    const seen = new Set<string>();
    const nodes: string[] = [];
    for (const index of net.pads) {
      const pad = board.pads[index];
      const key = `${pad.ref}\u0000${pad.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      nodes.push(`      (node (ref ${sx(pad.ref)}) (pin ${sx(pad.number)}) (pinfunction ${sx(pad.pin)}))`);
    }
    out.push(`    (net (code ${sx(String(i + 1))}) (name ${sx(net.name)})`, ...nodes, '    )');
  });
  out.push('  )', ')', '');
  return out.join('\n');
}

/** A footprint as a KiCad 6+ `.kicad_mod`. */
export function kicadFootprint(fp: Footprint): string {
  const c = fp.courtyard;
  const lines = [
    `(footprint ${sx(fp.name)} (version 20221018) (generator "benchtop")`,
    '  (layer "F.Cu")',
    '  (attr through_hole)',
    `  (fp_text reference "REF**" (at 0 ${n(c.y0 - 1.5)}) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))`,
    `  (fp_text value ${sx(fp.name)} (at 0 ${n(c.y1 + 1.5)}) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))`,
  ];
  for (const s of fp.silk) {
    if (s.kind === 'line') lines.push(`  (fp_line (start ${n(s.x1)} ${n(s.y1)}) (end ${n(s.x2)} ${n(s.y2)}) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))`);
    else lines.push(`  (fp_circle (center ${n(s.x)} ${n(s.y)}) (end ${n(s.x + s.r)} ${n(s.y)}) (stroke (width 0.12) (type solid)) (fill none) (layer "F.SilkS"))`);
  }
  lines.push(`  (fp_rect (start ${n(c.x0)} ${n(c.y0)}) (end ${n(c.x1)} ${n(c.y1)}) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))`);
  for (const p of fp.pads) {
    const shape = p.shape === 'rect' ? 'rect' : p.shape === 'oval' ? 'oval' : 'circle';
    lines.push(`  (pad ${sx(p.number)} thru_hole ${shape} (at ${n(p.x)} ${n(p.y)}) (size ${n(p.w)} ${n(p.h)}) (drill ${n(p.drill)}) (layers "*.Cu" "*.Mask"))`);
  }
  lines.push(')', '');
  return lines.join('\n');
}

/** The library files for every footprint on the board: `Benchtop.pretty/<name>.kicad_mod`. */
export function kicadLibrary(board: PcbBoard): { name: string; text: string }[] {
  const byName = new Map<string, Footprint>();
  for (const fp of board.placed) byName.set(fp.footprint.name, fp.footprint);
  return [...byName.keys()].sort().map((name) => ({ name: `Benchtop.pretty/${name}.kicad_mod`, text: kicadFootprint(byName.get(name)!) }));
}
