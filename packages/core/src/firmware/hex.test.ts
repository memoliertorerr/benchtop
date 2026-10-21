import { describe, expect, it } from 'vitest';
import { parseElf32, PT_LOAD } from './elf.ts';
import { readFixture, readFixtureText } from './fixtures.test-helper.ts';
import { HexError, parseIntelHex } from './hex.ts';

const UNO_FLASH = 32 * 1024;
const UNO_FIXTURES = [
  'analog-read',
  'blink',
  'button-pullup',
  'eeprom',
  'i2c-scan',
  'interrupt',
  'pwm-fade',
  'serial-echo',
  'timer1-ctc',
  'tone',
];

/** Builds one record with a correct checksum (independent of the parser under test). */
function record(type: number, address: number, data: readonly number[]): string {
  const bytes = [data.length, (address >> 8) & 0xff, address & 0xff, type, ...data];
  const sum = bytes.reduce((a, b) => a + b, 0);
  bytes.push((0x100 - (sum & 0xff)) & 0xff);
  return `:${bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('')}`;
}

const EOF = ':00000001FF';

/**
 * The flash image an AVR ELF describes. AVR ELFs place .data's initial values (its load
 * address, paddr) in flash right after .text while its vaddr is 0x800100+ in the data space,
 * so flash bytes come from paddr, and only segments with paddr < 0x8000 are flash.
 */
function flashFromElf(name: string): Uint8Array {
  const elf = parseElf32(readFixture(`fixtures/firmware/uno/${name}.elf`));
  const flashSegments = elf.segments.filter((s) => s.type === PT_LOAD && s.paddr < 0x8000 && s.filesz > 0);
  const end = Math.max(...flashSegments.map((s) => s.paddr + s.filesz));
  const flash = new Uint8Array(end).fill(0xff);
  for (const s of flashSegments) flash.set(s.data, s.paddr);
  return flash;
}

describe('parseIntelHex', () => {
  it('yields exactly the flash bytes of blink.elf', () => {
    const hex = parseIntelHex(readFixtureText('fixtures/firmware/uno/blink.hex'), { maxBytes: UNO_FLASH });
    const flash = flashFromElf('blink');
    expect(flash.length).toBe(0x7a8); // .text 0x78c + .data 0x1c (avr-readelf -l)
    expect(hex.bytes).toEqual(flash);
    expect(hex.used).toEqual([{ start: 0, end: 0x7a8 }]);
    expect(hex.startAddress).toBeUndefined();
  });

  it.each(UNO_FIXTURES)('matches the ELF flash image for %s', (name) => {
    const hex = parseIntelHex(readFixtureText(`fixtures/firmware/uno/${name}.hex`), { maxBytes: UNO_FLASH });
    expect(hex.bytes).toEqual(flashFromElf(name));
  });

  it('rejects a bad checksum, naming the line', () => {
    // The committed files use CRLF line endings; edit the checksum, not the '\r'.
    const lines = readFixtureText('fixtures/firmware/uno/blink.hex').split('\n');
    const line = lines[2].trimEnd();
    const last = line.slice(-2);
    lines[2] = `${line.slice(0, -2)}${last === '00' ? '01' : '00'}\r`;
    expect(() => parseIntelHex(lines.join('\n'), { maxBytes: UNO_FLASH })).toThrow(new HexError(3, 'bad checksum'));
  });

  it('rejects data beyond maxBytes, naming the line', () => {
    const text = [record(0, 0x00f0, [1, 2, 3, 4]), record(0, 0x00fe, [1, 2, 3, 4]), EOF].join('\n');
    expect(() => parseIntelHex(text, { maxBytes: 0x100 })).toThrow(HexError);
    try {
      parseIntelHex(text, { maxBytes: 0x100 });
    } catch (error) {
      expect((error as HexError).line).toBe(2);
      expect((error as HexError).message).toContain('beyond 256 bytes');
    }
  });

  it('rejects a missing end-of-file record', () => {
    const text = readFixtureText('fixtures/firmware/uno/blink.hex').replace(EOF, '');
    expect(() => parseIntelHex(text, { maxBytes: UNO_FLASH })).toThrow(/missing end-of-file record/);
  });

  it('rejects malformed records', () => {
    const bad = (line: string) => () => parseIntelHex(`${line}\n${EOF}\n`, { maxBytes: 0x100 });
    expect(bad('0400000001020304F2')).toThrow(/does not start with ":"/);
    expect(bad(':04000000010203G4F2')).toThrow(/invalid hex digit/);
    expect(bad(':0500000001020304F2')).toThrow(/byte count 5/);
    expect(bad(record(6, 0, []))).toThrow(/unknown record type 0x06/);
    expect(bad(':0400')).toThrow(/malformed record/);
    expect(() => parseIntelHex(`${EOF}\n${record(0, 0, [1])}`, { maxBytes: 0x100 })).toThrow(/after the end-of-file/);
    expect(() => parseIntelHex(EOF, { maxBytes: 0 })).toThrow(RangeError);
  });

  it('handles extended segment (02) and extended linear (04) addresses, and start records', () => {
    const text = [
      record(0, 0x0000, [0xaa]),
      record(2, 0, [0x10, 0x00]), // segment base 0x1000 × 16 = 0x10000
      record(0, 0x0004, [0xbb, 0xcc]),
      record(4, 0, [0x00, 0x02]), // linear base 0x0002 × 65536 = 0x20000
      record(0, 0x0010, [0xdd]),
      record(3, 0, [0x12, 0x34, 0x00, 0x05]), // CS:IP = 0x1234:0x0005
      record(5, 0, [0x40, 0x08, 0x29, 0xac]),
      EOF,
    ].join('\r\n');
    const hex = parseIntelHex(text, { maxBytes: 0x40000 });
    expect(hex.bytes.length).toBe(0x20011);
    expect(hex.bytes[0]).toBe(0xaa);
    expect(hex.bytes[1]).toBe(0xff); // never written: erased flash
    expect([hex.bytes[0x10004], hex.bytes[0x10005]]).toEqual([0xbb, 0xcc]);
    expect(hex.bytes[0x20010]).toBe(0xdd);
    expect(hex.used).toEqual([
      { start: 0, end: 1 },
      { start: 0x10004, end: 0x10006 },
      { start: 0x20010, end: 0x20011 },
    ]);
    // The type 05 record comes last, so it wins over the type 03 one (0x12345).
    expect(hex.startAddress).toBe(0x400829ac);
  });
});
