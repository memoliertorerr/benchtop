/**
 * DWARF `.debug_line` (versions 2–5, 32-bit DWARF only) → a packed line table: one row per line
 * program row, in typed arrays a worker can transfer. Lookups follow addr2line: an address maps
 * to the greatest row address ≤ it inside the sequence that covers it (the last of several rows
 * at that address); a file:line maps to the lowest is_stmt address per sequence.
 *
 * Untrusted input (Rule 6): every read is bounds-checked against its unit, counts are capped,
 * and anything malformed throws `DwarfError`; nothing reads outside the given bytes.
 *
 * Headers v2–v4 (v4 adds max_ops_per_inst); v5 directory/file entry formats with the content
 * types path, directory_index, timestamp, size and MD5 and the forms string, line_strp
 * (.debug_line_str), strp (.debug_str), udata, data1/2/4/8/16 and block. File indexes are
 * 1-based before v5, 0-based in v5. Standard opcodes 1–12 (advance_pc and special opcodes scale
 * by min_inst_length, fixed_advance_pc does not), extended opcodes 1–4; unknown opcodes are
 * skipped by their declared lengths.
 */

import { type Elf32, findSection } from './elf.ts';

export class DwarfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DwarfError';
  }
}

/** Most rows a table may hold (a hostile file can't make the parser allocate without bound). */
export const MAX_LINE_ROWS = 1_000_000;
/** Most directory or file entries one unit may declare. */
const MAX_ENTRIES = 65_536;

export const ROW_IS_STMT = 1;
export const ROW_END_SEQUENCE = 2;
/** `file` value of a row whose file index is out of range. */
export const NO_FILE = 0xffffffff;

/** The packed table: plain data, so it can cross a postMessage (typed arrays transfer). */
export interface LineTableData {
  /** Full paths as the producer wrote them (absolute, or relative to the build directory). */
  files: string[];
  address: Uint32Array;
  line: Uint32Array;
  /** Index into `files`, or NO_FILE. */
  file: Uint32Array;
  /** ROW_IS_STMT | ROW_END_SEQUENCE. */
  flags: Uint8Array;
  /** Sequences as row ranges [start, end] (end = the end_sequence row), sorted by low address. */
  seqStart: Uint32Array;
  seqEnd: Uint32Array;
}

export interface LineLocation {
  file: string;
  line: number;
  /** The row's own address (≤ the address asked for). */
  address: number;
}

export class LineTable {
  readonly data: LineTableData;

  constructor(data: LineTableData) {
    this.data = data;
  }

  get rowCount(): number {
    return this.data.address.length;
  }

  /** The source line of `addr`, or undefined when no sequence covers it (addr2line's "??:0"). */
  addressToLine(addr: number): LineLocation | undefined {
    const { address, seqStart, seqEnd, file, line, files } = this.data;
    // Sequences are sorted by low address: find the last one starting at or before addr, then
    // walk back to one that also ends after it (sequences rarely overlap).
    let lo = 0;
    let hi = seqStart.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (address[seqStart[mid]] <= addr) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    for (let s = found; s >= 0; s--) {
      const start = seqStart[s];
      const end = seqEnd[s];
      if (addr >= address[end] || addr < address[start]) continue;
      // The last row in [start, end) whose address is ≤ addr.
      let a = start;
      let b = end - 1;
      while (a < b) {
        const mid = (a + b + 1) >> 1;
        if (address[mid] <= addr) a = mid;
        else b = mid - 1;
      }
      const f = file[a];
      return { file: f === NO_FILE ? '??' : (files[f] ?? '??'), line: line[a], address: address[a] };
    }
    return undefined;
  }

  /**
   * The lowest is_stmt address of `line` in a file whose path ends with `fileSuffix` (a basename
   * or a trailing path), one per sequence, ascending.
   */
  lineToAddresses(fileSuffix: string, line: number): number[] {
    const { address, seqStart, seqEnd, file, flags, files } = this.data;
    const wanted = fileSuffix.replace(/\\/g, '/');
    const matches = new Uint8Array(files.length);
    files.forEach((path, i) => {
      const p = path.replace(/\\/g, '/');
      matches[i] = p === wanted || p.endsWith(`/${wanted}`) ? 1 : 0;
    });
    const out = new Set<number>();
    for (let s = 0; s < seqStart.length; s++) {
      let best = -1;
      for (let r = seqStart[s]; r < seqEnd[s]; r++) {
        const f = file[r];
        if (this.data.line[r] !== line || (flags[r] & ROW_IS_STMT) === 0 || f === NO_FILE || matches[f] !== 1) continue;
        if (best < 0 || address[r] < best) best = address[r];
      }
      if (best >= 0) out.add(best);
    }
    return [...out].sort((a, b) => a - b);
  }

  /** Every file path the table names. */
  get files(): readonly string[] {
    return this.data.files;
  }
}

/** The ELF's line table, or undefined when it has no .debug_line. Throws DwarfError. */
export function lineTableFromElf(elf: Elf32): LineTable | undefined {
  const section = findSection(elf, '.debug_line');
  if (section === undefined || section.data.length === 0) return undefined;
  return parseDebugLine(section.data, {
    lineStr: findSection(elf, '.debug_line_str')?.data,
    str: findSection(elf, '.debug_str')?.data,
  });
}

/** A bounds-checked little-endian reader over [pos, end). */
class Reader {
  readonly bytes: Uint8Array;
  pos: number;
  end: number;

  constructor(bytes: Uint8Array, pos: number, end: number) {
    this.bytes = bytes;
    this.pos = pos;
    this.end = end;
  }

  need(n: number): void {
    if (n < 0 || this.pos + n > this.end) throw new DwarfError(`truncated: need ${n} bytes at 0x${this.pos.toString(16)}`);
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }

  s8(): number {
    const v = this.u8();
    return v >= 0x80 ? v - 0x100 : v;
  }

  u16(): number {
    this.need(2);
    const v = this.bytes[this.pos] | (this.bytes[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const b = this.bytes;
    const p = this.pos;
    this.pos += 4;
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  }

  /** `size` bytes little-endian, the low 32 bits (addresses here are 32-bit). */
  address(size: number): number {
    if (size < 1 || size > 8) throw new DwarfError(`unsupported address size ${size}`);
    this.need(size);
    let v = 0;
    for (let i = 0; i < Math.min(size, 4); i++) v += this.bytes[this.pos + i] * 2 ** (8 * i);
    this.pos += size;
    return v >>> 0;
  }

  uleb(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.u8();
      result += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return result;
      scale *= 128;
    }
    throw new DwarfError('LEB128 longer than 10 bytes');
  }

  sleb(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.u8();
      result += (b & 0x7f) * scale;
      scale *= 128;
      if ((b & 0x80) === 0) return (b & 0x40) !== 0 ? result - scale : result;
    }
    throw new DwarfError('LEB128 longer than 10 bytes');
  }

  cstr(): string {
    const start = this.pos;
    while (this.pos < this.end && this.bytes[this.pos] !== 0) this.pos++;
    if (this.pos >= this.end) throw new DwarfError(`unterminated string at 0x${start.toString(16)}`);
    const text = utf8(this.bytes, start, this.pos);
    this.pos++;
    return text;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
}

/** A NUL-terminated string at `offset` in a string section. */
function stringAt(section: Uint8Array | undefined, offset: number, name: string): string {
  if (section === undefined) throw new DwarfError(`a string refers to ${name}, which the file lacks`);
  if (offset >= section.length) throw new DwarfError(`string offset 0x${offset.toString(16)} past the end of ${name}`);
  return new Reader(section, offset, section.length).cstr();
}

/** UTF-8 → string (DOM-free; malformed bytes become U+FFFD). */
function utf8(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  let i = start;
  while (i < end) {
    const b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      continue;
    }
    const n = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1;
    if (n < 0 || i + n > end) {
      out += '�';
      continue;
    }
    let cp = b & (0x3f >> n);
    let ok = true;
    for (let k = 0; k < n; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) ok = false;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (!ok || cp > 0x10ffff) {
      out += '�';
      continue;
    }
    i += n;
    out += String.fromCodePoint(cp);
  }
  return out;
}

const DW_LNCT_PATH = 1;
const DW_LNCT_DIRECTORY_INDEX = 2;

const DW_FORM_BLOCK = 0x09;
const DW_FORM_DATA1 = 0x0b;
const DW_FORM_DATA2 = 0x05;
const DW_FORM_DATA4 = 0x06;
const DW_FORM_DATA8 = 0x07;
const DW_FORM_DATA16 = 0x1e;
const DW_FORM_LINE_STRP = 0x1f;
const DW_FORM_STRING = 0x08;
const DW_FORM_STRP = 0x0e;
const DW_FORM_UDATA = 0x0f;

interface Strings {
  lineStr?: Uint8Array | undefined;
  str?: Uint8Array | undefined;
}

/** One v5 attribute value: a string for string forms, a number otherwise (skipped data → 0). */
function readForm(r: Reader, form: number, strings: Strings): string | number {
  switch (form) {
    case DW_FORM_STRING:
      return r.cstr();
    case DW_FORM_LINE_STRP:
      return stringAt(strings.lineStr, r.u32(), '.debug_line_str');
    case DW_FORM_STRP:
      return stringAt(strings.str, r.u32(), '.debug_str');
    case DW_FORM_UDATA:
      return r.uleb();
    case DW_FORM_DATA1:
      return r.u8();
    case DW_FORM_DATA2:
      return r.u16();
    case DW_FORM_DATA4:
      return r.u32();
    case DW_FORM_DATA8:
      return r.address(8);
    case DW_FORM_DATA16:
      r.skip(16);
      return 0;
    case DW_FORM_BLOCK:
      r.skip(r.uleb());
      return 0;
    default:
      throw new DwarfError(`unsupported form 0x${form.toString(16)} in a v5 line header`);
  }
}

/** v5: an entry format (content type, form pairs) then `count` entries → (path, directory index). */
function readEntries(r: Reader, strings: Strings): { path: string; dir: number }[] {
  const formatCount = r.u8();
  const format: [number, number][] = [];
  for (let i = 0; i < formatCount; i++) format.push([r.uleb(), r.uleb()]);
  const count = r.uleb();
  if (count > MAX_ENTRIES) throw new DwarfError(`${count} entries in a line header (max ${MAX_ENTRIES})`);
  const entries: { path: string; dir: number }[] = [];
  for (let i = 0; i < count; i++) {
    let path = '';
    let dir = 0;
    for (const [type, form] of format) {
      const value = readForm(r, form, strings);
      if (type === DW_LNCT_PATH && typeof value === 'string') path = value;
      else if (type === DW_LNCT_DIRECTORY_INDEX && typeof value === 'number') dir = value;
    }
    entries.push({ path, dir });
  }
  return entries;
}

const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
const joinPath = (dir: string | undefined, name: string): string =>
  isAbsolute(name) || dir === undefined || dir === '' ? name : `${dir.replace(/[\\/]+$/, '')}/${name}`;

/** Grows typed-array row storage by doubling (rows are pushed while the program runs). */
class Rows {
  address = new Uint32Array(1024);
  line = new Uint32Array(1024);
  file = new Uint32Array(1024);
  flags = new Uint8Array(1024);
  count = 0;
  readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  push(address: number, line: number, file: number, flags: number): void {
    if (this.count >= this.max) throw new DwarfError(`more than ${this.max} line rows`);
    if (this.count === this.address.length) {
      const size = Math.min(this.max, this.count * 2);
      const grow = <T extends Uint32Array | Uint8Array>(a: T, make: (n: number) => T): T => {
        const b = make(size);
        b.set(a);
        return b;
      };
      this.address = grow(this.address, (n) => new Uint32Array(n));
      this.line = grow(this.line, (n) => new Uint32Array(n));
      this.file = grow(this.file, (n) => new Uint32Array(n));
      this.flags = grow(this.flags, (n) => new Uint8Array(n));
    }
    this.address[this.count] = address;
    this.line[this.count] = line;
    this.file[this.count] = file;
    this.flags[this.count] = flags;
    this.count++;
  }
}

/** Parses a whole .debug_line section. Throws DwarfError on anything malformed. */
export function parseDebugLine(section: Uint8Array, strings: Strings = {}, maxRows = MAX_LINE_ROWS): LineTable {
  const files: string[] = [];
  const rows = new Rows(maxRows);
  const sequences: [number, number][] = [];
  let offset = 0;
  while (offset < section.length) {
    const head = new Reader(section, offset, section.length);
    const unitLength = head.u32();
    if (unitLength === 0xffffffff) throw new DwarfError('64-bit DWARF is not supported');
    if (unitLength >= 0xfffffff0) throw new DwarfError(`reserved unit length 0x${unitLength.toString(16)}`);
    const unitEnd = head.pos + unitLength;
    if (unitEnd > section.length) throw new DwarfError(`line unit at 0x${offset.toString(16)} runs past the section end`);
    parseUnit(new Reader(section, head.pos, unitEnd), strings, files, rows, sequences);
    offset = unitEnd;
  }
  sequences.sort((a, b) => rows.address[a[0]] - rows.address[b[0]] || rows.address[b[1]] - rows.address[a[1]]);
  const n = rows.count;
  return new LineTable({
    files,
    address: rows.address.slice(0, n),
    line: rows.line.slice(0, n),
    file: rows.file.slice(0, n),
    flags: rows.flags.slice(0, n),
    seqStart: Uint32Array.from(sequences, (s) => s[0]),
    seqEnd: Uint32Array.from(sequences, (s) => s[1]),
  });
}

function parseUnit(r: Reader, strings: Strings, files: string[], rows: Rows, sequences: [number, number][]): void {
  const version = r.u16();
  if (version < 2 || version > 5) throw new DwarfError(`line table version ${version} (expected 2–5)`);
  let addressSize = 0;
  if (version >= 5) {
    addressSize = r.u8();
    r.u8(); // segment_selector_size
  }
  const headerLength = r.u32();
  const programStart = r.pos + headerLength;
  if (programStart > r.end) throw new DwarfError('line header runs past its unit');
  const header = new Reader(r.bytes, r.pos, programStart);
  const minInst = header.u8();
  const maxOps = version >= 4 ? header.u8() : 1;
  if (maxOps === 0) throw new DwarfError('max_ops_per_inst is 0');
  const defaultIsStmt = header.u8() !== 0;
  const lineBase = header.s8();
  const lineRange = header.u8();
  if (lineRange === 0) throw new DwarfError('line_range is 0');
  const opcodeBase = header.u8();
  if (opcodeBase === 0) throw new DwarfError('opcode_base is 0');
  const opcodeLengths = new Uint8Array(opcodeBase);
  for (let i = 1; i < opcodeBase; i++) opcodeLengths[i] = header.u8();

  // This unit's files, as indexes into the global list.
  const unitFiles: number[] = [];
  const addFile = (path: string): void => {
    unitFiles.push(files.length);
    files.push(path);
  };
  if (version >= 5) {
    const dirs = readEntries(header, strings).map((e) => e.path);
    for (const entry of readEntries(header, strings)) addFile(joinPath(dirs[entry.dir], entry.path));
  } else {
    const dirs = ['']; // index 0: the compilation directory (in .debug_info, not read here)
    for (;;) {
      const dir = header.cstr();
      if (dir === '') break;
      if (dirs.length > MAX_ENTRIES) throw new DwarfError('too many include directories');
      dirs.push(dir);
    }
    for (;;) {
      const name = header.cstr();
      if (name === '') break;
      const dir = header.uleb();
      header.uleb(); // mtime
      header.uleb(); // length
      if (unitFiles.length > MAX_ENTRIES) throw new DwarfError('too many file entries');
      addFile(joinPath(dirs[dir], name));
    }
  }
  const fileBase = version >= 5 ? 0 : 1;
  const globalFile = (index: number): number => {
    const i = index - fileBase;
    return i >= 0 && i < unitFiles.length ? unitFiles[i] : NO_FILE;
  };

  r.pos = programStart;
  let address = 0;
  let opIndex = 0;
  let file = 1;
  let line = 1;
  let isStmt = defaultIsStmt;
  let seqStart = rows.count;
  const reset = (): void => {
    address = 0;
    opIndex = 0;
    file = 1;
    line = 1;
    isStmt = defaultIsStmt;
    seqStart = rows.count;
  };
  const advance = (operations: number): void => {
    if (maxOps === 1) {
      address = (address + minInst * operations) >>> 0;
    } else {
      address = (address + minInst * Math.floor((opIndex + operations) / maxOps)) >>> 0;
      opIndex = (opIndex + operations) % maxOps;
    }
  };
  const emit = (end: boolean): void => {
    rows.push(address, Math.max(0, line), globalFile(file), (isStmt ? ROW_IS_STMT : 0) | (end ? ROW_END_SEQUENCE : 0));
  };

  while (r.pos < r.end) {
    const opcode = r.u8();
    if (opcode >= opcodeBase) {
      const adjusted = opcode - opcodeBase;
      advance(Math.floor(adjusted / lineRange));
      line += lineBase + (adjusted % lineRange);
      emit(false);
      continue;
    }
    switch (opcode) {
      case 0: {
        const length = r.uleb();
        if (length === 0) break;
        r.need(length);
        const end = r.pos + length;
        const sub = r.u8();
        if (sub === 1) {
          emit(true);
          if (rows.count - 1 > seqStart) sequences.push([seqStart, rows.count - 1]);
          reset();
        } else if (sub === 2) {
          address = r.address(addressSize > 0 && version >= 5 ? addressSize : length - 1);
          opIndex = 0;
        } else if (sub === 3) {
          const name = r.cstr();
          r.uleb(); // directory index (relative names are kept as written)
          r.uleb();
          r.uleb();
          addFile(name);
        } else if (sub === 4) {
          r.uleb(); // discriminator
        }
        r.pos = end;
        break;
      }
      case 1: // copy
        emit(false);
        break;
      case 2: // advance_pc
        advance(r.uleb());
        break;
      case 3: // advance_line
        line += r.sleb();
        break;
      case 4: // set_file
        file = r.uleb();
        break;
      case 5: // set_column
        r.uleb();
        break;
      case 6: // negate_stmt
        isStmt = !isStmt;
        break;
      case 7: // set_basic_block
        break;
      case 8: // const_add_pc
        advance(Math.floor((255 - opcodeBase) / lineRange));
        break;
      case 9: // fixed_advance_pc: not scaled by min_inst_length
        address = (address + r.u16()) >>> 0;
        opIndex = 0;
        break;
      case 10: // set_prologue_end
      case 11: // set_epilogue_begin
        break;
      case 12: // set_isa
        r.uleb();
        break;
      default:
        // An opcode this parser doesn't know: skip its declared ULEB arguments.
        for (let i = 0; i < opcodeLengths[opcode]; i++) r.uleb();
    }
  }
}
