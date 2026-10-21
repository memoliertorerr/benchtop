import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DwarfError, lineTableFromElf, parseDebugLine } from './dwarf-line.ts';
import { findSection, parseElf32 } from './elf.ts';
import { readFixture as readFixtureBytes, readFixtureText, REPO_ROOT } from './fixtures.test-helper.ts';

const fixturePath = (path: string): string => resolve(REPO_ROOT, path);

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

// ── A tiny line-program assembler ────────────────────────────────────────────────────────────

const uleb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
const sleb = (n: number): number[] => {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
};
const le = (n: number, size: number): number[] => Array.from({ length: size }, (_, i) => Math.floor(n / 2 ** (8 * i)) & 0xff);
const cstr = (s: string): number[] => [...Array.from(s, (c) => c.charCodeAt(0)), 0];
const ext = (sub: number, body: number[]): number[] => [0, ...uleb(body.length + 1), sub, ...body];

interface Header {
  version: 3 | 4 | 5;
  minInst: number;
  lineBase: number;
  lineRange: number;
  opcodeBase: number;
  /** Arguments of standard opcodes 1..opcodeBase-1 (defaults to the standard ones). */
  lengths?: number[];
}
const STANDARD_LENGTHS = [0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1];

/** A whole unit: header fields, the v2–4 or v5 directory/file tables (pre-encoded), the program. */
function unit(h: Header, tables: number[], program: number[]): Uint8Array {
  const lengths = h.lengths ?? STANDARD_LENGTHS.slice(0, h.opcodeBase - 1);
  const params = [h.minInst, ...(h.version >= 4 ? [1] : []), 1, h.lineBase & 0xff, h.lineRange, h.opcodeBase, ...lengths];
  const afterHeaderLength = [...params, ...tables];
  const body = [...(h.version >= 5 ? [4, 0] : []), ...le(afterHeaderLength.length, 4), ...afterHeaderLength, ...program];
  const unitBody = [...le(h.version, 2), ...body];
  return Uint8Array.from([...le(unitBody.length, 4), ...unitBody]);
}

/** v2–4 tables: include directories, then files (name, dir index). */
const oldTables = (dirs: string[], files: [string, number][]): number[] => [
  ...dirs.flatMap(cstr),
  0,
  ...files.flatMap(([name, dir]) => [...cstr(name), ...uleb(dir), 0, 0]),
  0,
];

const special = (h: Header, ops: number, lines: number): number => {
  const opcode = lines - h.lineBase + h.lineRange * ops + h.opcodeBase;
  if (lines < h.lineBase || lines >= h.lineBase + h.lineRange || opcode > 255) throw new Error('no such special opcode');
  return opcode;
};

describe('DWARF line tables from the fixture ELFs', () => {
  const elves = readdirSync(fixturePath('fixtures/firmware/uno')).filter((f) => f.endsWith('.elf'));

  it('parses every fixtures/firmware/uno/*.elf (all DWARF v2)', () => {
    expect(elves.length).toBeGreaterThan(20);
    for (const name of elves) {
      const elf = parseElf32(readFixtureBytes(`fixtures/firmware/uno/${name}`));
      const section = findSection(elf, '.debug_line');
      expect(section, name).toBeDefined();
      // Every unit's version field (offset 4 of the unit) is 2.
      const data = section!.data;
      for (let offset = 0; offset < data.length; ) {
        expect(data[offset + 4] | (data[offset + 5] << 8), name).toBe(2);
        offset += 4 + (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24));
      }
      const table = lineTableFromElf(elf);
      expect(table?.rowCount, name).toBeGreaterThan(10);
    }
  });

  for (const name of ['blink', 'debug-demo']) {
    it(`${name}: every address in ${name}.addr2line.txt resolves as avr-addr2line does`, () => {
      const table = lineTableFromElf(parseElf32(readFixtureBytes(`fixtures/firmware/uno/${name}.elf`)))!;
      const oracle = readFixtureText(`fixtures/firmware/uno/${name}.addr2line.txt`).trim().split('\n');
      expect(oracle.length).toBeGreaterThan(40);
      let resolved = 0;
      for (const row of oracle) {
        const [hex, expected] = row.split(' ');
        const found = table.addressToLine(Number(hex));
        // "??:0" (nothing) and "??:?" (a symbol, no line row) both mean no line information.
        if (expected.startsWith('??')) {
          expect(found, row).toBeUndefined();
        } else {
          expect(found && `${basename(found.file)}:${found.line}`, row).toBe(expected);
          resolved++;
        }
      }
      expect(resolved).toBeGreaterThan(30);
    });
  }

  it("debug-demo: DEBUG_MARK's line has an is_stmt row", () => {
    const sketch = readFixtureText('fixtures/sketches/uno/debug-demo/debug-demo.ino').split('\n');
    const line = sketch.findIndex((l) => l.trimEnd().endsWith('// DEBUG_MARK')) + 1;
    expect(line).toBeGreaterThan(0);
    const table = lineTableFromElf(parseElf32(readFixtureBytes('fixtures/firmware/uno/debug-demo.elf')))!;
    const addresses = table.lineToAddresses('debug-demo.ino', line);
    if (addresses.length === 0) throw new Error(`debug-demo.ino:${line} (DEBUG_MARK) has no is_stmt row: adjust the sketch`);
    expect(table.addressToLine(addresses[0])).toMatchObject({ line });
  });
});

describe('hand-built line programs', () => {
  it('v3: special opcodes with min_inst_length 2, const_add_pc, fixed_advance_pc, negate_stmt, define_file', () => {
    const h: Header = { version: 3, minInst: 2, lineBase: -5, lineRange: 14, opcodeBase: 13 };
    const program = [
      ...ext(2, le(0x100, 4)), // set_address 0x100
      3, ...sleb(9), // advance_line → 10
      1, // copy: (0x100, 10)
      special(h, 2, 1), // 2 ops × 2 bytes: (0x104, 11)
      8, // const_add_pc: floor((255 − 13) / 14) = 17 ops = 34 bytes → 0x126
      special(h, 0, 2), // (0x126, 13)
      9, ...le(3, 2), // fixed_advance_pc 3 (not scaled) → 0x129
      1, // (0x129, 13)
      6, // negate_stmt
      special(h, 1, 0), // (0x12b, 13), not a statement
      6,
      ...ext(3, [...cstr('extra.c'), 0, 0, 0]), // define_file → file 2
      4, ...uleb(2), // set_file 2
      special(h, 1, 5), // (0x12d, 18) in extra.c
      2, ...uleb(3), // advance_pc 3 ops = 6 bytes → 0x133
      ...ext(1, []), // end_sequence
    ];
    const table = parseDebugLine(unit(h, oldTables(['src'], [['main.c', 1]]), program));
    const at = (a: number) => {
      const l = table.addressToLine(a);
      return l && `${l.file}:${l.line}`;
    };
    expect([0x100, 0x103, 0x104, 0x125, 0x126, 0x129, 0x12b, 0x12d, 0x132].map(at)).toEqual([
      'src/main.c:10',
      'src/main.c:10',
      'src/main.c:11',
      'src/main.c:11',
      'src/main.c:13',
      'src/main.c:13',
      'src/main.c:13',
      'extra.c:18',
      'extra.c:18',
    ]);
    expect(at(0x133)).toBeUndefined();
    expect(at(0xff)).toBeUndefined();
    expect(table.lineToAddresses('main.c', 13)).toEqual([0x126]);
    expect(table.lineToAddresses('src/main.c', 11)).toEqual([0x104]);
    expect(table.lineToAddresses('extra.c', 18)).toEqual([0x12d]);
    expect(table.lineToAddresses('main.c', 99)).toEqual([]);
  });

  it('v4: max_ops_per_inst, unknown standard and extended opcodes skipped, discriminators ignored', () => {
    // opcode_base 14: opcode 13 is a standard opcode this parser doesn't know, declared with 2 args.
    const h: Header = { version: 4, minInst: 2, lineBase: -3, lineRange: 12, opcodeBase: 14, lengths: [...STANDARD_LENGTHS, 2] };
    const program = [
      ...ext(2, le(0x2000, 4)),
      13, ...uleb(300), ...uleb(7), // unknown standard opcode: two ULEB args skipped
      ...ext(0x80, [1, 2, 3]), // unknown extended opcode: skipped by its length
      ...ext(4, uleb(3)), // set_discriminator
      1, // (0x2000, 1)
      special(h, 3, 4), // (0x2006, 5)
      2, ...uleb(1), // the sequence ends at 0x2008
      ...ext(1, []),
      // A second sequence at a lower address: lookups use the sequence that covers the address.
      ...ext(2, le(0x1000, 4)),
      3, ...sleb(41), // line 42
      1,
      2, ...uleb(1),
      ...ext(1, []),
    ];
    const table = parseDebugLine(unit(h, oldTables([], [['a.c', 0]]), program));
    expect(table.addressToLine(0x2003)).toEqual({ file: 'a.c', line: 1, address: 0x2000 });
    expect(table.addressToLine(0x2006)).toEqual({ file: 'a.c', line: 5, address: 0x2006 });
    expect(table.addressToLine(0x1001)).toEqual({ file: 'a.c', line: 42, address: 0x1000 });
    expect(table.addressToLine(0x1002)).toBeUndefined();
    expect(table.data.seqStart.length).toBe(2);
  });

  it('v5: entry formats with DW_FORM_string, DW_FORM_line_strp and MD5; 0-based file indexes', () => {
    const lineStr = Uint8Array.from([...cstr('/abs/build'), ...cstr('inc')]);
    const h: Header = { version: 5, minInst: 1, lineBase: -5, lineRange: 14, opcodeBase: 13 };
    const DW_LNCT = { path: 1, dir: 2, md5: 5 };
    const FORM = { string: 0x08, line_strp: 0x1f, udata: 0x0f, data16: 0x1e };
    const tables = [
      1, ...uleb(DW_LNCT.path), ...uleb(FORM.line_strp), // directory format
      ...uleb(2), ...le(0, 4), ...le(11, 4), // two directories via .debug_line_str
      3, ...uleb(DW_LNCT.path), ...uleb(FORM.string), ...uleb(DW_LNCT.dir), ...uleb(FORM.udata), ...uleb(DW_LNCT.md5), ...uleb(FORM.data16),
      ...uleb(2),
      ...cstr('main.c'), ...uleb(0), ...new Array(16).fill(0xab),
      ...cstr('util.h'), ...uleb(1), ...new Array(16).fill(0xcd),
    ];
    const program = [
      ...ext(2, le(0x400, 4)),
      4, ...uleb(0), // file 0 = main.c (v5 indexes are 0-based)
      3, ...sleb(6),
      1, // (0x400, main.c:7)
      4, ...uleb(1), // util.h
      special(h, 4, 3), // (0x404, util.h:10)
      2, ...uleb(4),
      ...ext(1, []),
    ];
    const table = parseDebugLine(unit(h, tables, program), { lineStr });
    expect(table.files).toEqual(['/abs/build/main.c', 'inc/util.h']);
    expect(table.addressToLine(0x402)).toEqual({ file: '/abs/build/main.c', line: 7, address: 0x400 });
    expect(table.addressToLine(0x405)).toEqual({ file: 'inc/util.h', line: 10, address: 0x404 });
    expect(table.lineToAddresses('util.h', 10)).toEqual([0x404]);
    // A line_strp past the end of .debug_line_str, or no .debug_line_str at all, is a DwarfError.
    expect(() => parseDebugLine(unit(h, tables, program))).toThrow(DwarfError);
  });
});

describe('malformed input', () => {
  const blink = findSection(parseElf32(readFixtureBytes('fixtures/firmware/uno/blink.elf')), '.debug_line')!.data;

  it('every truncation of a real section throws DwarfError, never reads out of bounds', () => {
    // Cutting exactly between two units leaves a valid section: skip those offsets.
    const boundaries = new Set<number>();
    for (let offset = 0; offset < blink.length; ) {
      offset += 4 + (blink[offset] | (blink[offset + 1] << 8) | (blink[offset + 2] << 16) | (blink[offset + 3] << 24));
      boundaries.add(offset);
    }
    let cuts = 0;
    for (let cut = 1; cut < blink.length; cut += 7) {
      if (boundaries.has(cut)) continue;
      expect(() => parseDebugLine(blink.subarray(0, cut)), `cut ${cut}`).toThrow(DwarfError);
      cuts++;
    }
    expect(cuts).toBeGreaterThan(300);
  });

  it('64-bit DWARF, oversized lengths and counts, and too many rows throw DwarfError', () => {
    expect(() => parseDebugLine(Uint8Array.from([0xff, 0xff, 0xff, 0xff, ...new Array(20).fill(0)]))).toThrow(/64-bit/);
    expect(() => parseDebugLine(Uint8Array.from([0x00, 0x00, 0x00, 0x80, 2, 0]))).toThrow(DwarfError);
    const h: Header = { version: 5, minInst: 1, lineBase: -5, lineRange: 14, opcodeBase: 13 };
    const hugeCount = [1, 1, 0x08, ...uleb(10_000_000)];
    expect(() => parseDebugLine(unit(h, hugeCount, []))).toThrow(DwarfError);
    const many = [...ext(2, le(0, 4)), ...new Array(10).fill(1), ...ext(1, [])];
    expect(() => parseDebugLine(unit({ ...h, version: 3 }, oldTables([], [['x.c', 0]]), many), {}, 5)).toThrow(/more than 5 line rows/);
    // A header length that runs past its unit.
    const bad = unit({ ...h, version: 3 }, oldTables([], []), []);
    bad[6] = 0xff;
    expect(() => parseDebugLine(bad)).toThrow(DwarfError);
  });

  it('random corruption of a real section either parses or throws DwarfError', () => {
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    for (let k = 0; k < 300; k++) {
      const copy = blink.slice();
      for (let flips = 0; flips < 4; flips++) copy[Math.floor(random() * copy.length)] = Math.floor(random() * 256);
      try {
        parseDebugLine(copy);
      } catch (error) {
        expect(error).toBeInstanceOf(DwarfError);
      }
    }
  });
});
