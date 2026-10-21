/**
 * Structural validation of untrusted project documents (files, browser storage, CLI input).
 * Hand-written on purpose: no schema library is worth its disk space here.
 *
 * It checks shape only. It does not know part types or pin names — that needs the catalog in
 * @benchtop/parts, which core never imports — so unknown types and pins surface later as bench
 * Problems. It collects every error it finds (up to MAX_ERRORS) instead of stopping at the
 * first, and on success returns a freshly built document holding only the known keys.
 *
 * Error paths are JSON Pointers (RFC 6901): "/parts/3/rotation", "" for the root.
 */

import type { FirmwareRef, PartInstance, PinRef, ProjectDoc, Wire } from '../contracts/project.ts';
import { PROJECT_FORMAT } from '../contracts/project.ts';

/** Most parts in one document. */
export const MAX_PARTS = 2000;
/** Most wires in one document. */
export const MAX_WIRES = 10_000;
/** Most waypoints in one wire. */
export const MAX_WAYPOINTS = 256;
/** Most props on one part. */
export const MAX_PROPS = 64;
/** Longest string anywhere in the document, in UTF-16 code units. */
export const MAX_STRING = 256;
/** Errors collected before validation gives up. */
export const MAX_ERRORS = 100;
/** Part and wire ids. Ids are unique among parts and among wires, separately. */
export const ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** An inline sketch's file names (BT42): a plain name, no folders, a C/C++/Arduino extension. */
export const SKETCH_FILE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.(?:ino|h|hpp|c|cpp)$/;
/** A MicroPython inline sketch's file names (BT63): a plain name, no folders, `.py`. */
export const MICROPYTHON_FILE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.py$/;

/** Whether an inline sketch's FQBN names MicroPython (`micropython:rp2:pico`): its files are .py and nothing compiles them. */
export function isMicroPythonFqbn(fqbn: string): boolean {
  return fqbn.startsWith('micropython:');
}
/** Most files in an inline sketch. */
export const MAX_SKETCH_FILES = 32;
/** Most source in an inline sketch, UTF-8 bytes over all its files. */
export const MAX_SKETCH_BYTES = 256 * 1024;
/** Prop names: identifier-like, so a key can never be `__proto__`. */
export const PROP_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** Wire colors: hex (#rgb, #rgba, #rrggbb, #rrggbbaa) or a CSS color name — never url(…). */
export const COLOR_PATTERN = /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]{1,32})$/;

/** One problem with the document: where (a JSON Pointer) and what. */
export interface ValidationError {
  path: string;
  message: string;
}

export type ParseProjectResult = { ok: true; doc: ProjectDoc } | { ok: false; errors: ValidationError[] };

const ROTATIONS = [0, 90, 180, 270] as const;
const FIRMWARE_FORMATS = ['hex', 'elf', 'esp32-bin', 'uf2'] as const;

/** Validates `input` (typically `JSON.parse` output) as a `ProjectDoc`. */
export function parseProject(input: unknown): ParseProjectResult {
  const c = new Collector();
  if (!isRecord(input)) {
    c.add('', `must be an object, got ${describe(input)}`);
    return { ok: false, errors: c.errors };
  }

  const format = field(input, 'format');
  if (format !== PROJECT_FORMAT) {
    c.add('/format', format === undefined ? 'is required' : `must be ${PROJECT_FORMAT}, got ${describe(format)}`);
  }
  const name = parseString(c, field(input, 'name'), '/name', true);

  const rawParts = field(input, 'parts');
  const declaredParts = new Set<string>();
  const parts = parseParts(c, rawParts, declaredParts);
  // Cross-references are checked only when the parts list itself was readable; otherwise every
  // wire end would also report "unknown part" and bury the real error. A part with a bad field
  // still declares its id.
  const listReadable = Array.isArray(rawParts) && rawParts.length <= MAX_PARTS;
  const knownParts = listReadable ? declaredParts : undefined;
  const wires = parseWires(c, field(input, 'wires'), knownParts);
  const firmware = parseFirmware(c, field(input, 'firmware'), knownParts);

  if (c.errors.length > 0 || name === undefined || parts === undefined || wires === undefined || firmware === undefined) {
    return { ok: false, errors: c.errors };
  }
  return { ok: true, doc: { format: PROJECT_FORMAT, name, parts, wires, firmware } };
}

class Collector {
  readonly errors: ValidationError[] = [];

  get full(): boolean {
    return this.errors.length >= MAX_ERRORS;
  }

  add(path: string, message: string): void {
    if (!this.full) this.errors.push({ path, message });
  }
}

function parseParts(c: Collector, value: unknown, declared: Set<string>): PartInstance[] | undefined {
  if (!checkArray(c, value, '/parts', MAX_PARTS, 'parts')) return undefined;
  const firstIndex = new Map<string, number>();
  const out: PartInstance[] = [];
  let ok = true;
  for (let i = 0; i < value.length && !c.full; i++) {
    const part = parsePart(c, value[i], `/parts/${i}`, i, firstIndex, declared);
    if (part === undefined) ok = false;
    else out.push(part);
  }
  return ok ? out : undefined;
}

function parsePart(
  c: Collector,
  value: unknown,
  path: string,
  index: number,
  firstIndex: Map<string, number>,
  declared: Set<string>,
): PartInstance | undefined {
  if (!isRecord(value)) {
    c.add(path, `must be an object, got ${describe(value)}`);
    return undefined;
  }
  const rawId = field(value, 'id');
  if (typeof rawId === 'string') declared.add(rawId);
  const id = parseId(c, rawId, `${path}/id`);
  let unique = true;
  if (id !== undefined) {
    const first = firstIndex.get(id);
    if (first === undefined) firstIndex.set(id, index);
    else {
      c.add(`${path}/id`, `duplicate part id "${id}" (also /parts/${first})`);
      unique = false;
    }
  }
  const type = parseString(c, field(value, 'type'), `${path}/type`, false);
  const x = parseNumber(c, field(value, 'x'), `${path}/x`);
  const y = parseNumber(c, field(value, 'y'), `${path}/y`);
  const rotation = parseRotation(c, field(value, 'rotation'), `${path}/rotation`);
  const props = parseProps(c, field(value, 'props'), `${path}/props`);
  if (
    id === undefined ||
    !unique ||
    type === undefined ||
    x === undefined ||
    y === undefined ||
    rotation === undefined ||
    props === undefined
  ) {
    return undefined;
  }
  return { id, type, x, y, rotation, props };
}

function parseRotation(c: Collector, value: unknown, path: string): PartInstance['rotation'] | undefined {
  // indexOf compares with ===, so -0 is accepted and normalized to 0.
  const i = typeof value === 'number' ? (ROTATIONS as readonly number[]).indexOf(value) : -1;
  if (i < 0) {
    c.add(path, `must be 0, 90, 180 or 270, got ${describe(value)}`);
    return undefined;
  }
  return ROTATIONS[i];
}

function parseProps(c: Collector, value: unknown, path: string): PartInstance['props'] | undefined {
  if (!isRecord(value)) {
    c.add(path, `must be an object, got ${describe(value)}`);
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_PROPS) {
    c.add(path, `has ${keys.length} props, at most ${MAX_PROPS} allowed`);
    return undefined;
  }
  const out: PartInstance['props'] = {};
  let ok = true;
  for (const key of keys) {
    const keyPath = `${path}/${escapePointer(key)}`;
    if (!PROP_KEY_PATTERN.test(key)) {
      c.add(keyPath, `prop name must match ${PROP_KEY_PATTERN.source}`);
      ok = false;
      continue;
    }
    const v = value[key];
    if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'number') {
      if (Number.isFinite(v)) out[key] = v;
      else {
        c.add(keyPath, `must be a finite number, got ${describe(v)}`);
        ok = false;
      }
    } else if (typeof v === 'string') {
      if (v.length <= MAX_STRING) out[key] = v;
      else {
        c.add(keyPath, `is ${v.length} characters long, at most ${MAX_STRING} allowed`);
        ok = false;
      }
    } else {
      c.add(keyPath, `must be a string, number or boolean, got ${describe(v)}`);
      ok = false;
    }
  }
  return ok ? out : undefined;
}

function parseWires(c: Collector, value: unknown, knownParts: ReadonlySet<string> | undefined): Wire[] | undefined {
  if (!checkArray(c, value, '/wires', MAX_WIRES, 'wires')) return undefined;
  const firstIndex = new Map<string, number>();
  const out: Wire[] = [];
  let ok = true;
  for (let i = 0; i < value.length && !c.full; i++) {
    const wire = parseWire(c, value[i], `/wires/${i}`, i, firstIndex, knownParts);
    if (wire === undefined) ok = false;
    else out.push(wire);
  }
  return ok ? out : undefined;
}

function parseWire(
  c: Collector,
  value: unknown,
  path: string,
  index: number,
  firstIndex: Map<string, number>,
  knownParts: ReadonlySet<string> | undefined,
): Wire | undefined {
  if (!isRecord(value)) {
    c.add(path, `must be an object, got ${describe(value)}`);
    return undefined;
  }
  const id = parseId(c, field(value, 'id'), `${path}/id`);
  let unique = true;
  if (id !== undefined) {
    const first = firstIndex.get(id);
    if (first === undefined) firstIndex.set(id, index);
    else {
      c.add(`${path}/id`, `duplicate wire id "${id}" (also /wires/${first})`);
      unique = false;
    }
  }
  const from = parsePinRef(c, field(value, 'from'), `${path}/from`, knownParts);
  const to = parsePinRef(c, field(value, 'to'), `${path}/to`, knownParts);
  const waypoints = parseWaypoints(c, field(value, 'waypoints'), `${path}/waypoints`);
  const color = parseColor(c, field(value, 'color'), `${path}/color`);
  if (id === undefined || !unique || from === undefined || to === undefined || waypoints === undefined || color === undefined) {
    return undefined;
  }
  return { id, from, to, waypoints, color };
}

function parsePinRef(
  c: Collector,
  value: unknown,
  path: string,
  knownParts: ReadonlySet<string> | undefined,
): PinRef | undefined {
  if (!isRecord(value)) {
    c.add(path, `must be an object { part, pin }, got ${describe(value)}`);
    return undefined;
  }
  let part = parseString(c, field(value, 'part'), `${path}/part`, false);
  if (part !== undefined && knownParts !== undefined && !knownParts.has(part)) {
    c.add(`${path}/part`, `names part "${part}", which is not in /parts`);
    part = undefined;
  }
  const pin = parseString(c, field(value, 'pin'), `${path}/pin`, false);
  if (part === undefined || pin === undefined) return undefined;
  return { part, pin };
}

function parseWaypoints(c: Collector, value: unknown, path: string): Wire['waypoints'] | undefined {
  if (!checkArray(c, value, path, MAX_WAYPOINTS, 'waypoints')) return undefined;
  const out: Wire['waypoints'] = [];
  let ok = true;
  for (let i = 0; i < value.length && !c.full; i++) {
    const point = value[i];
    const pointPath = `${path}/${i}`;
    if (!isRecord(point)) {
      c.add(pointPath, `must be an object { x, y }, got ${describe(point)}`);
      ok = false;
      continue;
    }
    const x = parseNumber(c, field(point, 'x'), `${pointPath}/x`);
    const y = parseNumber(c, field(point, 'y'), `${pointPath}/y`);
    if (x === undefined || y === undefined) ok = false;
    else out.push({ x, y });
  }
  return ok ? out : undefined;
}

function parseColor(c: Collector, value: unknown, path: string): string | undefined {
  if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) {
    c.add(path, `must be a hex color (#rgb, #rrggbb, …) or a color name, got ${describe(value)}`);
    return undefined;
  }
  return value;
}

function parseFirmware(
  c: Collector,
  value: unknown,
  knownParts: ReadonlySet<string> | undefined,
): ProjectDoc['firmware'] | undefined {
  if (!isRecord(value)) {
    c.add('/firmware', value === undefined ? 'is required' : `must be an object, got ${describe(value)}`);
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_PARTS) {
    c.add('/firmware', `has ${keys.length} entries, at most ${MAX_PARTS} allowed`);
    return undefined;
  }
  const out: ProjectDoc['firmware'] = {};
  let ok = true;
  for (const key of keys) {
    if (c.full) break;
    const path = `/firmware/${escapePointer(key)}`;
    if (!ID_PATTERN.test(key)) {
      c.add(path, `key must be a part id matching ${ID_PATTERN.source}`);
      ok = false;
      continue;
    }
    if (knownParts !== undefined && !knownParts.has(key)) {
      c.add(path, `names part "${key}", which is not in /parts`);
      ok = false;
      continue;
    }
    const ref = parseFirmwareRef(c, value[key], path);
    if (ref === undefined) ok = false;
    else out[key] = ref;
  }
  return ok ? out : undefined;
}

function parseFirmwareRef(c: Collector, value: unknown, path: string): FirmwareRef | undefined {
  if (!isRecord(value)) {
    c.add(path, `must be an object, got ${describe(value)}`);
    return undefined;
  }
  const kind = field(value, 'kind');
  if (kind === 'file') {
    const name = parseString(c, field(value, 'name'), `${path}/name`, false);
    const format = field(value, 'format');
    const i = typeof format === 'string' ? (FIRMWARE_FORMATS as readonly string[]).indexOf(format) : -1;
    if (i < 0) c.add(`${path}/format`, `must be "hex", "elf", "esp32-bin" or "uf2", got ${describe(format)}`);
    if (name === undefined || i < 0) return undefined;
    return { kind, name, format: FIRMWARE_FORMATS[i] };
  }
  if (kind === 'sketch') {
    const sketchPath = parseString(c, field(value, 'path'), `${path}/path`, false);
    const fqbn = parseString(c, field(value, 'fqbn'), `${path}/fqbn`, false);
    if (sketchPath === undefined || fqbn === undefined) return undefined;
    return { kind, path: sketchPath, fqbn };
  }
  if (kind === 'inline') return parseInlineSketch(c, value, path);
  c.add(`${path}/kind`, `must be "file", "sketch" or "inline", got ${describe(kind)}`);
  return undefined;
}

/** UTF-8 length of a string, without TextEncoder (not in every runtime this package runs in). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
      bytes += 4; // a surrogate pair
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * An inline sketch (BT42): fqbn, the files by name (each a string), the main .ino among them.
 * A MicroPython one (BT63, fqbn `micropython:…`) holds .py files, its main a .py among them.
 */
function parseInlineSketch(c: Collector, value: Record<string, unknown>, path: string): FirmwareRef | undefined {
  const fqbn = parseString(c, field(value, 'fqbn'), `${path}/fqbn`, false);
  const main = field(value, 'main');
  const files = field(value, 'files');
  let ok = fqbn !== undefined;
  const python = fqbn !== undefined && isMicroPythonFqbn(fqbn);
  const pattern = python ? MICROPYTHON_FILE_PATTERN : SKETCH_FILE_PATTERN;
  if (typeof main !== 'string' || !pattern.test(main) || !(python || main.endsWith('.ino'))) {
    c.add(`${path}/main`, `must name the sketch's ${python ? '.py' : '.ino'} file, got ${describe(main)}`);
    ok = false;
  }
  if (!isRecord(files)) {
    c.add(`${path}/files`, files === undefined ? 'is required' : `must be an object, got ${describe(files)}`);
    return undefined;
  }
  const names = Object.keys(files);
  if (names.length === 0 || names.length > MAX_SKETCH_FILES) {
    c.add(`${path}/files`, `has ${names.length} files, 1–${MAX_SKETCH_FILES} allowed`);
    return undefined;
  }
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const name of names) {
    const text = files[name];
    const at = `${path}/files/${escapePointer(name)}`;
    if (!pattern.test(name)) {
      c.add(at, `file name must match ${pattern.source}`);
      ok = false;
      continue;
    }
    if (typeof text !== 'string') {
      c.add(at, `must be the file's text, got ${describe(text)}`);
      ok = false;
      continue;
    }
    bytes += utf8Length(text);
    out[name] = text;
  }
  if (bytes > MAX_SKETCH_BYTES) {
    c.add(`${path}/files`, `hold ${bytes} bytes of source, at most ${MAX_SKETCH_BYTES} allowed`);
    ok = false;
  }
  if (typeof main === 'string' && ok && !Object.hasOwn(out, main)) {
    c.add(`${path}/main`, `names "${main}", which is not in files`);
    ok = false;
  }
  if (!ok || fqbn === undefined || typeof main !== 'string') return undefined;
  return { kind: 'inline', fqbn, files: out, main };
}

function parseId(c: Collector, value: unknown, path: string): string | undefined {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    c.add(path, `must be an id matching ${ID_PATTERN.source}, got ${describe(value)}`);
    return undefined;
  }
  return value;
}

function parseString(c: Collector, value: unknown, path: string, allowEmpty: boolean): string | undefined {
  if (typeof value !== 'string') {
    c.add(path, value === undefined ? 'is required' : `must be a string, got ${describe(value)}`);
    return undefined;
  }
  if (!allowEmpty && value.length === 0) {
    c.add(path, 'must not be empty');
    return undefined;
  }
  if (value.length > MAX_STRING) {
    c.add(path, `is ${value.length} characters long, at most ${MAX_STRING} allowed`);
    return undefined;
  }
  return value;
}

function parseNumber(c: Collector, value: unknown, path: string): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    c.add(path, value === undefined ? 'is required' : `must be a finite number, got ${describe(value)}`);
    return undefined;
  }
  return value;
}

/** True when `value` is an array no longer than `max`; records the error otherwise. */
function checkArray(c: Collector, value: unknown, path: string, max: number, what: string): value is unknown[] {
  if (!Array.isArray(value)) {
    c.add(path, value === undefined ? 'is required' : `must be an array, got ${describe(value)}`);
    return false;
  }
  if (value.length > max) {
    // Rejected as a whole: validating an oversized list item by item is the work a hostile
    // file wants us to do.
    c.add(path, `has ${value.length} ${what}, at most ${max} allowed`);
    return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own properties only, so nothing inherited (or planted on a prototype) is read as data. */
function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function escapePointer(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** A short rendering of a bad value for messages; never echoes long strings in full. */
function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
    case 'number':
    case 'boolean':
      return String(value);
    case 'object':
      return 'an object';
    default:
      return `a ${typeof value}`;
  }
}
