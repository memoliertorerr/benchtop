/**
 * ELF32 little-endian parser: program headers (PT_LOAD segments), section headers and the
 * symbol table. Used for AVR ELFs now and Xtensa ELFs later. The bytes are untrusted: every
 * offset and length is checked against the buffer before it is read, and segment and section
 * data are `subarray` views (no copies).
 */

/** e_machine for Atmel AVR. */
export const EM_AVR = 83;
/** e_machine for Tensilica Xtensa (ESP32). */
export const EM_XTENSA = 94;
/** BT72: 32-bit Arm (the RP2040's Cortex-M0+; Thumb function symbols carry bit 0). */
export const EM_ARM = 40;
/** p_type of a loadable segment. */
export const PT_LOAD = 1;
/** sh_type of a section that occupies no file space (.bss). */
export const SHT_NOBITS = 8;
/** sh_type of the full symbol table. */
export const SHT_SYMTAB = 2;

/** A malformed or unsupported ELF file. */
export class ElfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElfError';
  }
}

export interface ElfSegment {
  type: number;
  /** Address in the CPU's view (AVR: data space addresses are 0x800000 + n). */
  vaddr: number;
  /** Load address (AVR: where .data's initial values sit in flash). */
  paddr: number;
  filesz: number;
  memsz: number;
  flags: number;
  /** The file bytes of the segment (`filesz` long), a view into the input. */
  data: Uint8Array;
}

export interface ElfSection {
  name: string;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  /** The file bytes of the section, a view into the input; empty for SHT_NOBITS. */
  data: Uint8Array;
}

export type ElfSymbolType = 'NOTYPE' | 'OBJECT' | 'FUNC' | 'SECTION' | 'FILE' | 'COMMON' | 'TLS' | 'OTHER';
export type ElfSymbolBind = 'LOCAL' | 'GLOBAL' | 'WEAK' | 'OTHER';

export interface ElfSymbol {
  name: string;
  value: number;
  size: number;
  type: ElfSymbolType;
  bind: ElfSymbolBind;
  /** Section header index (0 = undefined, ≥ 0xff00 = special). */
  shndx: number;
}

export interface Elf32 {
  type: number;
  machine: number;
  entry: number;
  flags: number;
  /** PT_LOAD segments only, in file order. */
  segments: ElfSegment[];
  sections: ElfSection[];
  /** From .symtab (empty when the file is stripped). */
  symbols: ElfSymbol[];
}

const SYMBOL_TYPES: readonly ElfSymbolType[] = ['NOTYPE', 'OBJECT', 'FUNC', 'SECTION', 'FILE', 'COMMON', 'TLS'];
const SYMBOL_BINDS: readonly ElfSymbolBind[] = ['LOCAL', 'GLOBAL', 'WEAK'];

export function parseElf32(bytes: Uint8Array): Elf32 {
  if (bytes.length < 52) throw new ElfError(`file is ${bytes.length} bytes, too short for an ELF32 header`);
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new ElfError('not an ELF file (bad magic)');
  }
  if (bytes[4] !== 1) throw new ElfError(`only 32-bit ELF is supported (EI_CLASS ${bytes[4]})`);
  if (bytes[5] !== 1) throw new ElfError(`only little-endian ELF is supported (EI_DATA ${bytes[5]})`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number): number => view.getUint16(offset, true);
  const u32 = (offset: number): number => view.getUint32(offset, true);

  const type = u16(16);
  const machine = u16(18);
  const entry = u32(24);
  const phoff = u32(28);
  const shoff = u32(32);
  const flags = u32(36);
  const phentsize = u16(42);
  const phnum = u16(44);
  const shentsize = u16(46);
  const shnum = u16(48);
  const shstrndx = u16(50);

  const segments: ElfSegment[] = [];
  if (phnum > 0) {
    if (phentsize < 32) throw new ElfError(`program header entry size ${phentsize} is below 32`);
    checkRange(bytes, phoff, phnum * phentsize, 'program header table');
    for (let i = 0; i < phnum; i++) {
      const at = phoff + i * phentsize;
      if (u32(at) !== PT_LOAD) continue;
      const offset = u32(at + 4);
      const filesz = u32(at + 16);
      checkRange(bytes, offset, filesz, `segment ${i}`);
      segments.push({
        type: PT_LOAD,
        vaddr: u32(at + 8),
        paddr: u32(at + 12),
        filesz,
        memsz: u32(at + 20),
        flags: u32(at + 24),
        data: bytes.subarray(offset, offset + filesz),
      });
    }
  }

  const raw: { nameOffset: number; type: number; flags: number; addr: number; offset: number; size: number; link: number; entsize: number }[] = [];
  if (shnum > 0) {
    if (shentsize < 40) throw new ElfError(`section header entry size ${shentsize} is below 40`);
    checkRange(bytes, shoff, shnum * shentsize, 'section header table');
    for (let i = 0; i < shnum; i++) {
      const at = shoff + i * shentsize;
      const sectionType = u32(at + 4);
      const offset = u32(at + 16);
      const size = u32(at + 20);
      if (sectionType !== SHT_NOBITS && i !== 0) checkRange(bytes, offset, size, `section ${i}`);
      raw.push({
        nameOffset: u32(at),
        type: sectionType,
        flags: u32(at + 8),
        addr: u32(at + 12),
        offset,
        size,
        link: u32(at + 24),
        entsize: u32(at + 36),
      });
    }
  } else if (shoff !== 0) {
    throw new ElfError('extended section numbering (e_shnum = 0) is not supported');
  }
  if (raw.length > 0 && shstrndx >= raw.length) throw new ElfError(`section name table index ${shstrndx} out of range`);
  const names = raw.length > 0 ? sectionData(bytes, raw[shstrndx]) : new Uint8Array(0);
  const sections: ElfSection[] = raw.map((s) => ({
    name: s.nameOffset === 0 && s.type === 0 ? '' : readString(names, s.nameOffset, 'section name'),
    type: s.type,
    flags: s.flags,
    addr: s.addr,
    offset: s.offset,
    size: s.size,
    data: sectionData(bytes, s),
  }));

  const symbols: ElfSymbol[] = [];
  const symtabIndex = raw.findIndex((s) => s.type === SHT_SYMTAB);
  if (symtabIndex >= 0) {
    const symtab = raw[symtabIndex];
    if (symtab.link >= raw.length) throw new ElfError(`.symtab string table index ${symtab.link} out of range`);
    const strings = sectionData(bytes, raw[symtab.link]);
    const entsize = symtab.entsize === 0 ? 16 : symtab.entsize;
    if (entsize < 16) throw new ElfError(`symbol entry size ${entsize} is below 16`);
    const table = sections[symtabIndex].data;
    const symView = new DataView(table.buffer, table.byteOffset, table.byteLength);
    for (let at = 0; at + 16 <= table.length; at += entsize) {
      const info = table[at + 12];
      symbols.push({
        name: readString(strings, symView.getUint32(at, true), 'symbol name'),
        value: symView.getUint32(at + 4, true),
        size: symView.getUint32(at + 8, true),
        type: SYMBOL_TYPES[info & 0xf] ?? 'OTHER',
        bind: SYMBOL_BINDS[info >> 4] ?? 'OTHER',
        shndx: symView.getUint16(at + 14, true),
      });
    }
  }

  return { type, machine, entry, flags, segments, sections, symbols };
}

/** The first section called `name`, or undefined. */
export function findSection(elf: Elf32, name: string): ElfSection | undefined {
  return elf.sections.find((s) => s.name === name);
}

/** The first symbol called `name` (FUNC/OBJECT preferred over other types), or undefined. */
export function findSymbol(elf: Elf32, name: string): ElfSymbol | undefined {
  let fallback: ElfSymbol | undefined;
  for (const symbol of elf.symbols) {
    if (symbol.name !== name) continue;
    if (symbol.type === 'FUNC' || symbol.type === 'OBJECT') return symbol;
    fallback ??= symbol;
  }
  return fallback;
}

function checkRange(bytes: Uint8Array, offset: number, length: number, what: string): void {
  if (offset > bytes.length || length > bytes.length - offset) {
    throw new ElfError(`${what} (offset 0x${offset.toString(16)}, ${length} bytes) runs past the end of the ${bytes.length}-byte file`);
  }
}

function sectionData(bytes: Uint8Array, s: { type: number; offset: number; size: number }): Uint8Array {
  return s.type === SHT_NOBITS ? bytes.subarray(0, 0) : bytes.subarray(s.offset, s.offset + s.size);
}

/** A NUL-terminated UTF-8 string at `offset` in a string table. */
function readString(table: Uint8Array, offset: number, what: string): string {
  if (offset >= table.length) {
    if (offset === 0 && table.length === 0) return '';
    throw new ElfError(`${what} offset ${offset} is outside its ${table.length}-byte string table`);
  }
  let end = offset;
  while (end < table.length && table[end] !== 0) end++;
  if (end === table.length) throw new ElfError(`${what} at offset ${offset} is not NUL-terminated`);
  return decodeUtf8(table, offset, end);
}

/** UTF-8 decoding without TextDecoder (not in the DOM-free ES2023 lib); bad bytes → U+FFFD. */
function decodeUtf8(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  let i = start;
  while (i < end) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
      continue;
    }
    const need = b >= 0xf8 ? -1 : b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1;
    if (need < 0 || i + need >= end) {
      out += '�';
      i++;
      continue;
    }
    let code = b & (0x3f >> need);
    let ok = true;
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) ok = false;
      code = (code << 6) | (c & 0x3f);
    }
    if (!ok || code > 0x10ffff) {
      out += '�';
      i++;
      continue;
    }
    out += String.fromCodePoint(code);
    i += need + 1;
  }
  return out;
}
