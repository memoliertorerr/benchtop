/**
 * Gerber RS-274X (BT58) for a PcbBoard: front and back copper, front and back solder mask, the
 * front silkscreen and the board outline — the layers a hobby fab asks for — with X2 file
 * attributes (file function, polarity). Millimetres, `%FSLAX46Y46*%` (coordinates in 10⁻⁶ mm),
 * absolute, linear interpolation only. The bench's y grows down, Gerber's up: y is negated.
 * Pads flash their aperture (C circle, R rectangle, O obround), vias flash a circle (tented: not
 * in the mask), traces and outlines draw with a circle aperture of their width. Mask openings
 * are the pads grown by MASK_EXPANSION on each side. Deterministic: the same board gives the same
 * bytes (no dates).
 */

import type { PcbBoard, PlacedFootprint } from '../board.ts';
import { rotate } from '../geometry.ts';
import { textStrokes, textWidth } from './font.ts';

/** Solder mask opening beyond each pad, per side, mm. */
export const MASK_EXPANSION = 0.05;
/** Silkscreen line width and reference text height, mm. */
export const SILK_WIDTH = 0.15;
export const REF_HEIGHT = 1.0;
/** Outline (Edge.Cuts) line width, mm. */
export const EDGE_WIDTH = 0.1;
/** Segments of a silkscreen circle. */
const CIRCLE_SEGMENTS = 36;

const coord = (v: number): string => String(Math.round(v * 1e6));
const mm = (v: number): string => v.toFixed(6);

class GerberWriter {
  private readonly apertures = new Map<string, number>();
  private readonly lines: string[] = [];
  private current = -1;
  private readonly attributes: readonly string[];

  constructor(attributes: readonly string[]) {
    this.attributes = attributes;
  }

  private select(template: string): void {
    let code = this.apertures.get(template);
    if (code === undefined) this.apertures.set(template, (code = 10 + this.apertures.size));
    if (code !== this.current) {
      this.lines.push(`D${code}*`);
      this.current = code;
    }
  }

  flashCircle(x: number, y: number, d: number): void {
    this.select(`C,${mm(d)}`);
    this.lines.push(`X${coord(x)}Y${coord(-y)}D03*`);
  }

  flashRect(x: number, y: number, w: number, h: number): void {
    this.select(`R,${mm(w)}X${mm(h)}`);
    this.lines.push(`X${coord(x)}Y${coord(-y)}D03*`);
  }

  flashObround(x: number, y: number, w: number, h: number): void {
    this.select(`O,${mm(w)}X${mm(h)}`);
    this.lines.push(`X${coord(x)}Y${coord(-y)}D03*`);
  }

  /** A polyline drawn with a round aperture of `width`. */
  stroke(points: readonly { x: number; y: number }[], width: number): void {
    if (points.length < 2) return;
    this.select(`C,${mm(width)}`);
    this.lines.push(`X${coord(points[0].x)}Y${coord(-points[0].y)}D02*`);
    for (let i = 1; i < points.length; i++) this.lines.push(`X${coord(points[i].x)}Y${coord(-points[i].y)}D01*`);
  }

  text(): string {
    const head = ['%TF.GenerationSoftware,Benchtop,Benchtop,1*%', ...this.attributes.map((a) => `%${a}*%`), '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%', 'G01*'];
    const defs = [...this.apertures].map(([template, code]) => `%ADD${code}${template}*%`);
    return [...head, ...defs, ...this.lines, 'M02*', ''].join('\n');
  }
}

export interface GerberFile {
  /** File name suffix after the board name (KiCad's, so fabs recognize the layer). */
  suffix: string;
  text: string;
}

function padFlash(w: GerberWriter, p: { x: number; y: number; w: number; h: number; shape: string }, grow: number): void {
  const pw = p.w + 2 * grow;
  const ph = p.h + 2 * grow;
  if (p.shape === 'rect') w.flashRect(p.x, p.y, pw, ph);
  else if (p.shape === 'oval' && pw !== ph) w.flashObround(p.x, p.y, pw, ph);
  else w.flashCircle(p.x, p.y, Math.min(pw, ph));
}

function copper(board: PcbBoard, layer: 'F' | 'B'): string {
  const w = new GerberWriter([`TF.FileFunction,Copper,${layer === 'F' ? 'L1,Top' : 'L2,Bot'}`, 'TF.FilePolarity,Positive']);
  for (const p of board.pads) padFlash(w, p, 0);
  for (const v of board.pcb.vias) w.flashCircle(v.x, v.y, v.diameter);
  for (const t of board.pcb.traces) if (t.layer === layer) w.stroke(t.points, t.width);
  return w.text();
}

function mask(board: PcbBoard, layer: 'F' | 'B'): string {
  const w = new GerberWriter([`TF.FileFunction,Soldermask,${layer === 'F' ? 'Top' : 'Bot'}`, 'TF.FilePolarity,Negative']);
  for (const p of board.pads) padFlash(w, p, MASK_EXPANSION);
  return w.text();
}

/** Silkscreen strokes of one placed footprint (outline, circles) and its reference, on the board. */
export function footprintSilk(fp: PlacedFootprint): { x: number; y: number }[][] {
  const out: { x: number; y: number }[][] = [];
  const { x, y, rotation, ref } = fp.doc;
  const at = (px: number, py: number): { x: number; y: number } => {
    const r = rotate(px, py, rotation);
    return { x: x + r.x, y: y + r.y };
  };
  for (const s of fp.footprint.silk) {
    if (s.kind === 'line') out.push([at(s.x1, s.y1), at(s.x2, s.y2)]);
    else out.push(Array.from({ length: CIRCLE_SEGMENTS + 1 }, (_, k) => at(s.x + s.r * Math.cos((2 * Math.PI * k) / CIRCLE_SEGMENTS), s.y + s.r * Math.sin((2 * Math.PI * k) / CIRCLE_SEGMENTS))));
  }
  // The reference, centred above the courtyard.
  const c = fp.courtyard;
  const tx = (c.x0 + c.x1) / 2 - textWidth(ref, REF_HEIGHT) / 2;
  for (const s of textStrokes(ref, tx, c.y0 - REF_HEIGHT - 0.4, REF_HEIGHT)) out.push([{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }]);
  return out;
}

/** Silkscreen strokes of every footprint, on the board. */
export function silkStrokes(board: PcbBoard): { x: number; y: number }[][] {
  return board.placed.flatMap(footprintSilk);
}

function silk(board: PcbBoard): string {
  const w = new GerberWriter(['TF.FileFunction,Legend,Top', 'TF.FilePolarity,Positive']);
  for (const line of silkStrokes(board)) w.stroke(line, SILK_WIDTH);
  return w.text();
}

function edge(board: PcbBoard): string {
  const w = new GerberWriter(['TF.FileFunction,Profile,NP', 'TF.FilePolarity,Positive']);
  const o = board.pcb.outline;
  if (o.length >= 3) w.stroke([...o, o[0]], EDGE_WIDTH);
  return w.text();
}

/** The Gerber files of a board. */
export function gerberFiles(board: PcbBoard): GerberFile[] {
  return [
    { suffix: '-F_Cu.gtl', text: copper(board, 'F') },
    { suffix: '-B_Cu.gbl', text: copper(board, 'B') },
    { suffix: '-F_Mask.gts', text: mask(board, 'F') },
    { suffix: '-B_Mask.gbs', text: mask(board, 'B') },
    { suffix: '-F_Silkscreen.gto', text: silk(board) },
    { suffix: '-Edge_Cuts.gm1', text: edge(board) },
  ];
}
