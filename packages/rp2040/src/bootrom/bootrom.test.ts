import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { createRp2040Mcu } from '../rp2040-mcu.ts';
import { f32Bits, f64Words } from './float.ts';
import { buildBootrom, romCode, romTableLookup, ROM_VERSION, SD_TABLE, SF_TABLE } from './layout.ts';

// BT60: our bootrom against the RP2040 datasheet §2.8.3 — the fixed header (table 163), the
// lookup tables, and every function called the way the SDK calls it, from Thumb code
// (fixtures/rp2040/romcalls.c, loaded as an ELF).

describe('bootrom layout', () => {
  const { image } = buildBootrom();
  const bytes = new Uint8Array(image.buffer);
  const view = new DataView(image.buffer);
  const read16 = (a: number): number => view.getUint16(a, true);

  it('has the header at the datasheet\'s fixed addresses', () => {
    expect(view.getUint32(0, true)).toBe(0x20042000);
    for (const vector of [4, 8, 12]) expect(view.getUint32(vector, true) & 1).toBe(1); // Thumb handlers
    expect(Array.from(bytes.subarray(0x10, 0x14))).toEqual([0x4d, 0x75, 0x01, ROM_VERSION]);
    expect(read16(0x18) & 1).toBe(1);
  });

  it('lists every documented function and data code (tables 164–168, 171)', () => {
    for (const code of ['P3', 'R3', 'L3', 'T3', 'MS', 'S4', 'MC', 'C4', 'IF', 'EX', 'RE', 'RP', 'FC', 'CX', 'DT', 'DE', 'UB', 'WV']) expect(romTableLookup(read16, read16(0x14), romCode(code)), code).not.toBe(0);
    for (const code of ['CR', 'GR', 'FS', 'SF', 'FE', 'SD']) expect(romTableLookup(read16, read16(0x16), romCode(code)), code).not.toBe(0);
    expect(romTableLookup(read16, read16(0x16), romCode('SF'))).toBe(SF_TABLE);
    expect(romTableLookup(read16, read16(0x16), romCode('SD'))).toBe(SD_TABLE);
    expect(bytes[SF_TABLE - 2]).toBeGreaterThanOrEqual(32); // the SDK asserts the V2 size
    expect(romTableLookup(read16, read16(0x14), romCode('ZZ'))).toBe(0);
  });
});

describe('bootrom functions from Thumb code', () => {
  it('romcalls.elf: every function through rom_func_lookup / rom_data_lookup', () => {
    const mcu = createRp2040Mcu();
    mcu.load({ format: 'elf', bytes: readFixture('fixtures/rp2040/romcalls.elf') });
    expect(mcu.runUntil(125_000).reason).toBe('target'); // 1 ms
    const out = Array.from({ length: 35 }, (_, i) => mcu.rp.readUint32(0x20030000 + 4 * i) >>> 0);
    const F = (x: number): number => f32Bits(x);
    const [lo, hi] = f64Words(0.1 + 0.2);
    expect(out).toEqual([
      0x0301754d, // 'M' 'u' 0x01, version 3
      9, // popcount32(0xf0f00001)
      0x80000000, // reverse32(1)
      15, 32, // clz32(0x10000), clz32(0)
      16, 32, // ctz32(0x10000), ctz32(0)
      1, // memset returns ptr
      0xababab00, 0x00ababab, // six 0xAB bytes from offset 1
      0x5a5a5a5a, // memset4
      0xababab00, // memcpy of six bytes (and of none)
      0x20042000, // memcpy44 of the vector table from flash
      0x3f3e3d3c, // flash_range_program, read back through XIP
      0xffffffff, // erased, not programmed
      0x3b3a3938, // programming again ANDs bits in
      1, // an unknown code finds nothing
      1, // the copyright string
      32, // the soft float table's size byte
      F(3.75), F(-0.75), F(-3.375), F(Math.fround(1 / 3)), F(Math.SQRT2),
      0xfffffffd, // float2int(−2.5) rounds toward −∞
      0x8000, // float2fix(0.5, 16)
      0, // float2uint(−1) clamps
      F(-7),
      F(Math.sin(0.5)),
      0xff800000, // fln(0) = −∞
      0xffffffff, // fcmp(1, 2) = −1
      lo, hi, // dadd(0.1, 0.2)
      F(1 / 3), // double2float
      0xd0e,
    ]);
  });
});
