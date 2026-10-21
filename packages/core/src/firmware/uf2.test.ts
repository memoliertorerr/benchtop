import { describe, expect, it } from 'vitest';
import { buildUf2, parseUf2, placeUf2, UF2_FAMILY, Uf2Error } from './uf2.ts';
import { readFixture } from './fixtures.test-helper.ts';

const picoFirmware = (name: string): Uint8Array => readFixture(`fixtures/firmware/pico/${name}.uf2`);

describe('UF2', () => {
  it('parses a fixture: RP2040 family, 256-byte payloads, contiguous flash from 0x10000000', () => {
    const uf2 = parseUf2(picoFirmware('blink'));
    expect(uf2.familyId).toBe(UF2_FAMILY.RP2040);
    expect(uf2.blocks[0].address).toBe(0x10000000);
    for (let i = 1; i < uf2.blocks.length; i++) expect(uf2.blocks[i].address).toBe(uf2.blocks[i - 1].address + 256);
    expect(uf2.blocks.every((b) => b.data.length === 256)).toBe(true);
  });

  it('round-trips through buildUf2', () => {
    const data = Uint8Array.from({ length: 600 }, (_, i) => i & 0xff);
    const uf2 = parseUf2(buildUf2([{ address: 0x20000000, data }], UF2_FAMILY.RP2040));
    expect(uf2.blocks.map((b) => [b.address, b.data.length])).toEqual([
      [0x20000000, 256],
      [0x20000100, 256],
      [0x20000200, 88],
    ]);
    const memory = new Uint8Array(600);
    placeUf2(uf2, [{ start: 0x20000000, end: 0x20042000 }], (a, d) => memory.set(d, a - 0x20000000));
    expect(memory).toEqual(data);
  });

  it('rejects malformed files with a reason', () => {
    const good = buildUf2([{ address: 0x10000000, data: new Uint8Array(512) }], UF2_FAMILY.RP2040);
    const corrupt = (mutate: (v: DataView) => void): Uint8Array => {
      const copy = good.slice();
      mutate(new DataView(copy.buffer));
      return copy;
    };
    expect(() => parseUf2(good.subarray(0, 100))).toThrow(Uf2Error);
    expect(() => parseUf2(corrupt((v) => v.setUint32(0, 0, true)))).toThrow(/magic/);
    expect(() => parseUf2(corrupt((v) => v.setUint32(16, 477, true)))).toThrow(/payload size/);
    expect(() => parseUf2(corrupt((v) => v.setUint32(20, 9, true)))).toThrow(/block number/);
    expect(() => parseUf2(corrupt((v) => v.setUint32(512 + 20, 0, true)))).toThrow(/appears twice/);
    expect(() => parseUf2(corrupt((v) => v.setUint32(512 + 24, 3, true)))).toThrow(/blocks in all/);
    expect(() => parseUf2(corrupt((v) => v.setUint32(512 + 28, UF2_FAMILY.RP2350_RISCV, true)))).toThrow(/family/);
    const outside = parseUf2(buildUf2([{ address: 0x30000000, data: new Uint8Array(16) }], UF2_FAMILY.RP2040));
    expect(() => placeUf2(outside, [{ start: 0x10000000, end: 0x11000000 }], () => {})).toThrow(/outside/);
  });

  it('skips blocks flagged "not main flash"', () => {
    const file = buildUf2([{ address: 0x10000000, data: new Uint8Array(512) }], UF2_FAMILY.RP2040);
    new DataView(file.buffer).setUint32(8, 0x2001, true); // the first block: not main flash
    expect(parseUf2(file).blocks.map((b) => b.address)).toEqual([0x10000100]);
  });

  it('reads concatenated block sequences (RP2350-E10: an ABSOLUTE block before the image)', () => {
    const lone = buildUf2([{ address: 0x10ffff00, data: new Uint8Array(256).fill(0xef) }], UF2_FAMILY.ABSOLUTE);
    new DataView(lone.buffer).setUint32(24, 2, true); // one block of a declared two, as picotool writes it
    const image = buildUf2([{ address: 0x10000000, data: new Uint8Array(512).fill(7) }], UF2_FAMILY.RP2350_RISCV);
    const file = new Uint8Array(lone.length + image.length);
    file.set(lone);
    file.set(image, lone.length);
    const uf2 = parseUf2(file);
    expect(uf2.familyId).toBe(UF2_FAMILY.RP2350_RISCV);
    expect(uf2.blocks.map((b) => [b.address, b.family])).toEqual([
      [0x10ffff00, UF2_FAMILY.ABSOLUTE],
      [0x10000000, UF2_FAMILY.RP2350_RISCV],
      [0x10000100, UF2_FAMILY.RP2350_RISCV],
    ]);
  });
});
