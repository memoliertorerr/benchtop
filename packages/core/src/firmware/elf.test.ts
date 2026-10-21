import { describe, expect, it } from 'vitest';
import { EM_AVR, ElfError, findSection, findSymbol, parseElf32, PT_LOAD, SHT_NOBITS } from './elf.ts';
import { readFixture } from './fixtures.test-helper.ts';

// Expected values come from the toolchain, not from this parser: `avr-readelf -h -l -S` and
// `avr-nm -S` (avr-gcc 7.3.0-atmel3.6.1-arduino7) on fixtures/firmware/uno/blink.elf.

const blink = (): Uint8Array => readFixture('fixtures/firmware/uno/blink.elf').slice();

describe('parseElf32', () => {
  it('reads blink.elf: machine, entry, PT_LOAD segments, sections and symbols', () => {
    const bytes = blink();
    const elf = parseElf32(bytes);
    expect(elf.machine).toBe(EM_AVR);
    expect(elf.machine).toBe(83);
    expect(elf.entry).toBe(0);
    expect(elf.segments.map(({ type, vaddr, paddr, filesz, memsz }) => ({ type, vaddr, paddr, filesz, memsz }))).toEqual([
      { type: PT_LOAD, vaddr: 0x000000, paddr: 0x000000, filesz: 0x78c, memsz: 0x78c },
      { type: PT_LOAD, vaddr: 0x800100, paddr: 0x00078c, filesz: 0x01c, memsz: 0x01c },
      { type: PT_LOAD, vaddr: 0x80011c, paddr: 0x80011c, filesz: 0x000, memsz: 0x0a6 },
    ]);
    // Views into the input, not copies.
    expect(elf.segments[0].data.buffer).toBe(bytes.buffer);
    expect(elf.segments[0].data.byteOffset).toBe(0x94);

    expect(elf.sections).toHaveLength(17);
    expect(findSection(elf, '.text')).toMatchObject({ addr: 0, offset: 0x94, size: 0x78c });
    const bss = findSection(elf, '.bss');
    expect(bss).toMatchObject({ type: SHT_NOBITS, addr: 0x80011c, size: 0xa6 });
    expect(bss?.data.length).toBe(0);
    expect(findSection(elf, '.debug_line')?.data.length).toBe(0xa98);

    expect(findSymbol(elf, 'main')).toMatchObject({ value: 0x5b2, size: 0x170, type: 'FUNC', bind: 'GLOBAL' });
    // TIMER0_OVF, which millis() needs.
    expect(findSymbol(elf, '__vector_16')).toMatchObject({ value: 0x46e, size: 0x94, type: 'FUNC', bind: 'GLOBAL' });
    expect(findSymbol(elf, 'no_such_symbol')).toBeUndefined();
  });

  it('rejects files that are not little-endian ELF32', () => {
    expect(() => parseElf32(blink().subarray(0, 40))).toThrow(/too short/);
    const notElf = blink();
    notElf[1] = 0x46;
    expect(() => parseElf32(notElf)).toThrow(/bad magic/);
    const elf64 = blink();
    elf64[4] = 2;
    expect(() => parseElf32(elf64)).toThrow(/only 32-bit/);
    const bigEndian = blink();
    bigEndian[5] = 2;
    expect(() => parseElf32(bigEndian)).toThrow(/only little-endian/);
  });

  // Each case corrupts one header field; the parser must throw ElfError, never read past the
  // buffer (a RangeError from DataView would mean an unchecked read).
  const patch = (offset: (bytes: Uint8Array, view: DataView) => number, value: number, width: 2 | 4 = 4) => {
    const bytes = blink();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = offset(bytes, view);
    if (width === 4) view.setUint32(at, value, true);
    else view.setUint16(at, value, true);
    return bytes;
  };
  const shoff = (view: DataView) => view.getUint32(32, true);
  const section = (view: DataView, index: number, field: number) => shoff(view) + index * 40 + field;

  it.each([
    ['a header cut off after the ELF header', () => blink().slice(0, 52), /program header table/],
    ['phoff near 4 GiB', () => patch(() => 28, 0xfffffff0), /program header table/],
    ['phnum past the end', () => patch(() => 44, 0xffff, 2), /program header table/],
    ['a segment offset past the end', () => patch((_, v) => v.getUint32(28, true) + 4, 0x7fffffff), /segment 0/],
    ['a segment size past the end', () => patch((_, v) => v.getUint32(28, true) + 16, 0xffffffff), /segment 0/],
    ['shoff near 4 GiB', () => patch(() => 32, 0xffffff00), /section header table/],
    ['a section size past the end', () => patch((_, v) => section(v, 2, 20), 0x7fffffff), /section 2/],
    ['shstrndx out of range', () => patch(() => 50, 99, 2), /section name table index/],
    ['a section name outside .shstrtab', () => patch((_, v) => section(v, 1, 0), 0x10000), /section name offset/],
    ['a symbol name outside .strtab', () => patch((_, v) => v.getUint32(section(v, 15, 16), true) + 16, 0xfffffff), /symbol name offset/],
    ['a .symtab link out of range', () => patch((_, v) => section(v, 15, 24), 99), /string table index/],
  ] as const)('rejects %s', (_label, make, message) => {
    const bytes = make();
    expect(() => parseElf32(bytes)).toThrow(ElfError);
    expect(() => parseElf32(bytes)).toThrow(message);
  });
});
