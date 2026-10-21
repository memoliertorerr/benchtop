/**
 * A PCB from a bench project (BT57): every part that belongs on a board gets a footprint where
 * the part sits on the bench (its centre, its rotation) and a reference designator; the outline
 * is the footprints' bounding box plus 3 mm, rounded out to whole millimetres. Reconciling keeps
 * a laid-out PCB in step with an edited bench: removed parts lose their footprints, new ones are
 * put in a column right of the board, references never change.
 */

import type { PartInstance, ProjectDoc } from '@benchtop/core';
import type { CatalogLookup } from './board.ts';
import { compareRefs } from './board.ts';
import { DEFAULT_RULES, emptyPcb, type PcbDoc, type PcbFootprint } from './doc.ts';
import { footprintOf, refPrefix } from './footprints.ts';
import { type Box, rotate } from './geometry.ts';

/** Space between the parts and the board edge, mm. */
export const OUTLINE_MARGIN = 3;

/** "led10" after "led9": ids compared by their text, then their trailing number. */
function compareIds(a: string, b: string): number {
  const ma = /^(.*?)(\d+)$/.exec(a);
  const mb = /^(.*?)(\d+)$/.exec(b);
  if (ma !== null && mb !== null && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The parts of a project that go on a PCB, in id order. */
function boardParts(project: ProjectDoc, catalog: CatalogLookup): PartInstance[] {
  return project.parts.filter((p) => {
    const def = catalog(p.type);
    return def !== undefined && footprintOf(def) !== null;
  });
}

/** The footprint's courtyard on the board, for a footprint placed at (x, y) turned by rotation. */
export function courtyardAt(type: string, catalog: CatalogLookup, x: number, y: number, rotation: number): Box | null {
  const def = catalog(type);
  const fp = def === undefined ? null : footprintOf(def);
  if (fp === null) return null;
  const a = rotate(fp.courtyard.x0, fp.courtyard.y0, rotation);
  const b = rotate(fp.courtyard.x1, fp.courtyard.y1, rotation);
  return { x0: x + Math.min(a.x, b.x), y0: y + Math.min(a.y, b.y), x1: x + Math.max(a.x, b.x), y1: y + Math.max(a.y, b.y) };
}

/** Next free reference numbers per prefix, given the ones in use. */
function refAllocator(taken: Iterable<string>): (prefix: string) => string {
  const used = new Set(taken);
  return (prefix) => {
    let n = 1;
    while (used.has(`${prefix}${n}`)) n++;
    const ref = `${prefix}${n}`;
    used.add(ref);
    return ref;
  };
}

/** A new PCB for a project: footprints where the parts are, refs by type in id order, an outline. */
export function seedPcb(project: ProjectDoc, catalog: CatalogLookup): PcbDoc {
  const pcb = emptyPcb(project.name);
  const parts = boardParts(project, catalog);
  const byPrefix = new Map<string, PartInstance[]>();
  for (const part of parts) {
    const prefix = refPrefix(catalog(part.type)!);
    const list = byPrefix.get(prefix) ?? [];
    list.push(part);
    byPrefix.set(prefix, list);
  }
  const refOf = new Map<string, string>();
  for (const [prefix, list] of byPrefix) list.sort((a, b) => compareIds(a.id, b.id)).forEach((p, i) => refOf.set(p.id, `${prefix}${i + 1}`));
  pcb.footprints = parts.map((part): PcbFootprint => {
    const def = catalog(part.type)!;
    return { part: part.id, ref: refOf.get(part.id)!, x: round(part.x + def.size.w / 2), y: round(part.y + def.size.h / 2), rotation: part.rotation };
  });
  pcb.footprints.sort((a, b) => compareRefs(a.ref, b.ref));
  pcb.outline = outlineAround(pcb.footprints, project, catalog);
  pcb.rules = { ...DEFAULT_RULES };
  return pcb;
}

/** A rectangle around every footprint's courtyard, OUTLINE_MARGIN out, on whole millimetres. */
export function outlineAround(footprints: readonly PcbFootprint[], project: ProjectDoc, catalog: CatalogLookup): { x: number; y: number }[] {
  let box: Box | null = null;
  for (const fp of footprints) {
    const type = project.parts.find((p) => p.id === fp.part)?.type;
    const c = type === undefined ? null : courtyardAt(type, catalog, fp.x, fp.y, fp.rotation);
    if (c === null) continue;
    box = box === null ? { ...c } : { x0: Math.min(box.x0, c.x0), y0: Math.min(box.y0, c.y0), x1: Math.max(box.x1, c.x1), y1: Math.max(box.y1, c.y1) };
  }
  if (box === null) return [];
  const x0 = Math.floor(box.x0 - OUTLINE_MARGIN);
  const y0 = Math.floor(box.y0 - OUTLINE_MARGIN);
  const x1 = Math.ceil(box.x1 + OUTLINE_MARGIN);
  const y1 = Math.ceil(box.y1 + OUTLINE_MARGIN);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/**
 * The PCB brought in step with the project: footprints of parts gone (or no longer on a PCB)
 * removed, new parts' footprints added in a column right of the outline (top down, 2 mm apart),
 * everything else — positions, refs, traces, vias, outline, rules — kept. Returns the same
 * document when nothing changed.
 */
export function reconcilePcb(pcb: PcbDoc, project: ProjectDoc, catalog: CatalogLookup): PcbDoc {
  const parts = boardParts(project, catalog);
  const wanted = new Set(parts.map((p) => p.id));
  const kept = pcb.footprints.filter((f) => wanted.has(f.part));
  const placed = new Set(kept.map((f) => f.part));
  const fresh = parts.filter((p) => !placed.has(p.id)).sort((a, b) => compareIds(a.id, b.id));
  if (fresh.length === 0 && kept.length === pcb.footprints.length) return pcb;
  const nextRef = refAllocator(kept.map((f) => f.ref));
  const xs = pcb.outline.map((p) => p.x);
  const ys = pcb.outline.map((p) => p.y);
  const x = (xs.length > 0 ? Math.max(...xs) : 0) + 10;
  let y = ys.length > 0 ? Math.min(...ys) : 0;
  const added = fresh.map((part): PcbFootprint => {
    const def = catalog(part.type)!;
    const c = courtyardAt(part.type, catalog, 0, 0, part.rotation)!;
    const fp = { part: part.id, ref: nextRef(refPrefix(def)), x: round(x - c.x0), y: round(y - c.y0), rotation: part.rotation };
    y += c.y1 - c.y0 + 2;
    return fp;
  });
  return { ...pcb, footprints: [...kept, ...added] };
}

const round = (v: number): number => Math.round(v * 1000) / 1000;
