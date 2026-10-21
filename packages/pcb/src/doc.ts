/**
 * The PCB document (BT57): a board laid out for one bench project, kept beside the project
 * (`*.pcb.json`; the project document itself is unchanged). It holds only what a person draws —
 * the outline, where each footprint sits, traces and vias, the rules; footprints, pads and nets
 * always come from the project and the catalog, so a PCB can't disagree with its circuit.
 * Documents from outside are untrusted: `parsePcb` checks every field and size, collects errors
 * with JSON Pointer paths, and returns a freshly built document holding only known keys.
 */

import type { Point } from './geometry.ts';

export const PCB_FORMAT = 1;

export type Layer = 'F' | 'B';
export const LAYERS: readonly Layer[] = ['F', 'B'];

export interface PcbFootprint {
  /** The project's part id. */
  part: string;
  /** Reference designator (R1, D2, A1 …), unique on the board. */
  ref: string;
  /** Footprint origin (the part's centre), mm. */
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface PcbTrace {
  id: string;
  layer: Layer;
  /** Copper width, mm. */
  width: number;
  /** At least two; consecutive points are straight segments. */
  points: Point[];
}

export interface PcbVia {
  id: string;
  x: number;
  y: number;
  /** Hole and copper diameters, mm. */
  drill: number;
  diameter: number;
}

export interface PcbRules {
  /** Copper to copper of another net, mm. */
  clearance: number;
  minWidth: number;
  minDrill: number;
  /** (pad or via diameter − drill) / 2, mm. */
  minAnnular: number;
  /** Copper to the board edge, mm. */
  edgeClearance: number;
  /** Defaults for new traces and vias. */
  traceWidth: number;
  viaDrill: number;
  viaDiameter: number;
}

export interface PcbDoc {
  format: 1;
  /** The project's name when it was made (informational). */
  name: string;
  /** Board outline: a closed polygon (≥ 3 points), mm. */
  outline: Point[];
  footprints: PcbFootprint[];
  traces: PcbTrace[];
  vias: PcbVia[];
  rules: PcbRules;
}

/** Decided defaults: a hobby fab's 2-layer limits with room to spare. */
export const DEFAULT_RULES: Readonly<PcbRules> = {
  clearance: 0.2,
  minWidth: 0.25,
  minDrill: 0.3,
  minAnnular: 0.15,
  edgeClearance: 0.5,
  traceWidth: 0.4,
  viaDrill: 0.4,
  viaDiameter: 0.8,
};

export const PCB_LIMITS = {
  footprints: 2000,
  traces: 20_000,
  pointsPerTrace: 1000,
  vias: 20_000,
  outlinePoints: 1000,
  /** |coordinate| bound, mm. */
  extent: 10_000,
  idLength: 32,
  nameLength: 256,
} as const;

export function emptyPcb(name: string): PcbDoc {
  return { format: 1, name, outline: [], footprints: [], traces: [], vias: [], rules: { ...DEFAULT_RULES } };
}

export interface PcbError {
  path: string;
  message: string;
}

export type ParsePcbResult = { ok: true; doc: PcbDoc } | { ok: false; errors: PcbError[] };

const MAX_ERRORS = 100;
const ID = /^[A-Za-z0-9_.-]{1,32}$/;

/** Validates an untrusted PCB document. */
export function parsePcb(input: unknown): ParsePcbResult {
  const errors: PcbError[] = [];
  const fail = (path: string, message: string): void => {
    if (errors.length < MAX_ERRORS) errors.push({ path, message });
  };
  const obj = (v: unknown, path: string): Record<string, unknown> | null => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      fail(path, 'must be an object');
      return null;
    }
    return v as Record<string, unknown>;
  };
  const num = (v: unknown, path: string, min: number, max: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      fail(path, `must be a number in [${min}, ${max}]`);
      return 0;
    }
    return v;
  };
  const coord = (v: unknown, path: string): number => num(v, path, -PCB_LIMITS.extent, PCB_LIMITS.extent);
  const id = (v: unknown, path: string): string => {
    if (typeof v !== 'string' || !ID.test(v)) {
      fail(path, 'must be an id of 1–32 letters, digits, "_", "." or "-"');
      return '';
    }
    return v;
  };
  const list = (v: unknown, path: string, max: number): unknown[] => {
    if (!Array.isArray(v)) {
      fail(path, 'must be an array');
      return [];
    }
    if (v.length > max) {
      fail(path, `has more than ${max} entries`);
      return [];
    }
    return v;
  };
  const point = (v: unknown, path: string): Point => {
    const o = obj(v, path);
    return o === null ? { x: 0, y: 0 } : { x: coord(o.x, `${path}/x`), y: coord(o.y, `${path}/y`) };
  };

  const root = obj(input, '');
  if (root === null) return { ok: false, errors };
  if (root.format !== PCB_FORMAT) fail('/format', `must be ${PCB_FORMAT}`);
  const name = typeof root.name === 'string' && root.name.length <= PCB_LIMITS.nameLength ? root.name : (fail('/name', `must be a string of at most ${PCB_LIMITS.nameLength} characters`), '');

  const outline = list(root.outline, '/outline', PCB_LIMITS.outlinePoints).map((p, i) => point(p, `/outline/${i}`));
  if (outline.length > 0 && outline.length < 3) fail('/outline', 'needs at least 3 points (or none)');

  const refs = new Set<string>();
  const parts = new Set<string>();
  const footprints = list(root.footprints, '/footprints', PCB_LIMITS.footprints).map((raw, i): PcbFootprint => {
    const path = `/footprints/${i}`;
    const o = obj(raw, path) ?? {};
    const part = id(o.part, `${path}/part`);
    const ref = typeof o.ref === 'string' && /^[A-Z]{1,4}[0-9]{1,5}$/.test(o.ref) ? o.ref : (fail(`${path}/ref`, 'must be a designator like R1 or SW12'), '');
    if (ref !== '' && refs.has(ref)) fail(`${path}/ref`, `"${ref}" is used twice`);
    if (part !== '' && parts.has(part)) fail(`${path}/part`, `"${part}" is placed twice`);
    refs.add(ref);
    parts.add(part);
    const rotation = o.rotation === 0 || o.rotation === 90 || o.rotation === 180 || o.rotation === 270 ? o.rotation : (fail(`${path}/rotation`, 'must be 0, 90, 180 or 270'), 0);
    return { part, ref, x: coord(o.x, `${path}/x`), y: coord(o.y, `${path}/y`), rotation };
  });

  const ids = new Set<string>();
  const unique = (v: string, path: string): void => {
    if (v !== '' && ids.has(v)) fail(path, `"${v}" is used twice`);
    ids.add(v);
  };
  const traces = list(root.traces, '/traces', PCB_LIMITS.traces).map((raw, i): PcbTrace => {
    const path = `/traces/${i}`;
    const o = obj(raw, path) ?? {};
    const tid = id(o.id, `${path}/id`);
    unique(tid, `${path}/id`);
    const layer = o.layer === 'F' || o.layer === 'B' ? o.layer : (fail(`${path}/layer`, 'must be "F" or "B"'), 'F' as const);
    const points = list(o.points, `${path}/points`, PCB_LIMITS.pointsPerTrace).map((p, j) => point(p, `${path}/points/${j}`));
    if (points.length < 2) fail(`${path}/points`, 'needs at least 2 points');
    return { id: tid, layer, width: num(o.width, `${path}/width`, 0.05, 20), points };
  });
  const vias = list(root.vias, '/vias', PCB_LIMITS.vias).map((raw, i): PcbVia => {
    const path = `/vias/${i}`;
    const o = obj(raw, path) ?? {};
    const vid = id(o.id, `${path}/id`);
    unique(vid, `${path}/id`);
    const drill = num(o.drill, `${path}/drill`, 0.1, 10);
    const diameter = num(o.diameter, `${path}/diameter`, 0.1, 20);
    if (diameter <= drill) fail(`${path}/diameter`, 'must be larger than the drill');
    return { id: vid, x: coord(o.x, `${path}/x`), y: coord(o.y, `${path}/y`), drill, diameter };
  });

  const r = root.rules === undefined ? {} : (obj(root.rules, '/rules') ?? {});
  const rule = (key: keyof PcbRules, min: number, max: number): number => (r[key] === undefined ? DEFAULT_RULES[key] : num(r[key], `/rules/${key}`, min, max));
  const rules: PcbRules = {
    clearance: rule('clearance', 0.05, 10),
    minWidth: rule('minWidth', 0.05, 10),
    minDrill: rule('minDrill', 0.1, 10),
    minAnnular: rule('minAnnular', 0, 5),
    edgeClearance: rule('edgeClearance', 0, 10),
    traceWidth: rule('traceWidth', 0.05, 20),
    viaDrill: rule('viaDrill', 0.1, 10),
    viaDiameter: rule('viaDiameter', 0.1, 20),
  };

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, doc: { format: 1, name, outline, footprints, traces, vias, rules } };
}
