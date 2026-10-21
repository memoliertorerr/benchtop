/**
 * A small Gerber RS-274X and Excellon reader for the export tests (BT58): apertures C/R/O,
 * D01/D02/D03 with linear interpolation, regions (G36/G37, kept as their outlines), format
 * 4.6 mm. It turns a file back into primitives that can say whether a point is copper — an
 * independent check of what gerber.ts writes.
 */

import { type Capsule, type Rect, shapeDistance } from '../geometry.ts';

export type Primitive = Capsule | Rect;

export interface GerberImage {
  attributes: string[];
  primitives: Primitive[];
  /** Stroked polylines (D02 then D01s), in order, for the outline check. */
  paths: { x: number; y: number }[][];
}

export function readGerber(text: string): GerberImage {
  const apertures = new Map<number, { kind: string; a: number; b: number }>();
  const attributes: string[] = [];
  const primitives: Primitive[] = [];
  const paths: { x: number; y: number }[][] = [];
  let current: { kind: string; a: number; b: number } | undefined;
  let x = 0;
  let y = 0;
  let path: { x: number; y: number }[] | null = null;
  let format = false;
  let units = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line === 'G01*' || line === '%LPD*%') continue;
    if (line === '%FSLAX46Y46*%') {
      format = true;
      continue;
    }
    if (line === '%MOMM*%') {
      units = true;
      continue;
    }
    if (line.startsWith('%TF.')) {
      attributes.push(line.slice(1, -2));
      continue;
    }
    let m = /^%ADD(\d+)([CRO]),([\d.]+)(?:X([\d.]+))?\*%$/.exec(line);
    if (m !== null) {
      apertures.set(Number(m[1]), { kind: m[2], a: Number(m[3]), b: m[4] === undefined ? Number(m[3]) : Number(m[4]) });
      continue;
    }
    m = /^D(\d+)\*$/.exec(line);
    if (m !== null && Number(m[1]) >= 10) {
      current = apertures.get(Number(m[1]));
      if (current === undefined) throw new Error(`undefined aperture ${line}`);
      continue;
    }
    if (line === 'M02*') break;
    m = /^X(-?\d+)Y(-?\d+)D0([123])\*$/.exec(line);
    if (m === null) throw new Error(`unexpected Gerber line: ${line}`);
    if (!format || !units) throw new Error('coordinates before %FS / %MO');
    if (current === undefined) throw new Error('no aperture selected');
    const nx = Number(m[1]) / 1e6;
    const ny = -Number(m[2]) / 1e6;
    const op = m[3];
    if (op === '2') {
      path = [{ x: nx, y: ny }];
      paths.push(path);
    } else if (op === '1') {
      if (current.kind !== 'C') throw new Error('stroke with a non-circular aperture');
      primitives.push({ k: 'cap', x1: x, y1: y, x2: nx, y2: ny, r: current.a / 2 });
      path?.push({ x: nx, y: ny });
    } else {
      path = null;
      if (current.kind === 'C') primitives.push({ k: 'cap', x1: nx, y1: ny, x2: nx, y2: ny, r: current.a / 2 });
      else if (current.kind === 'R') primitives.push({ k: 'rect', x0: nx - current.a / 2, y0: ny - current.b / 2, x1: nx + current.a / 2, y1: ny + current.b / 2 });
      else {
        const r = Math.min(current.a, current.b) / 2;
        primitives.push(current.a > current.b ? { k: 'cap', x1: nx - current.a / 2 + r, y1: ny, x2: nx + current.a / 2 - r, y2: ny, r } : { k: 'cap', x1: nx, y1: ny - current.b / 2 + r, x2: nx, y2: ny + current.b / 2 - r, r });
      }
    }
    x = nx;
    y = ny;
  }
  return { attributes, primitives, paths };
}

/** True when (x, y) is covered by the image. */
export function covered(image: GerberImage, x: number, y: number): boolean {
  const p: Capsule = { k: 'cap', x1: x, y1: y, x2: x, y2: y, r: 0 };
  return image.primitives.some((q) => shapeDistance(p, q) <= 1e-6);
}

/** Holes of an Excellon file. */
export function readExcellon(text: string): { x: number; y: number; d: number }[] {
  const tools = new Map<string, number>();
  const holes: { x: number; y: number; d: number }[] = [];
  let tool: number | undefined;
  let header = true;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '%') {
      header = false;
      continue;
    }
    let m = /^(T\d+)C([\d.]+)$/.exec(line);
    if (m !== null && header) {
      tools.set(m[1], Number(m[2]));
      continue;
    }
    m = /^(T\d+)$/.exec(line);
    if (m !== null && !header) {
      tool = tools.get(m[1]);
      continue;
    }
    m = /^X(-?[\d.]+)Y(-?[\d.]+)$/.exec(line);
    if (m !== null) {
      if (tool === undefined) throw new Error('hole before a tool');
      holes.push({ x: Number(m[1]), y: -Number(m[2]), d: tool });
    }
  }
  return holes;
}
