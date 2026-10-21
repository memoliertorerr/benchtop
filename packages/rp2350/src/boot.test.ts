import { describe, expect, it } from 'vitest';
import { BootError, findImageDef, MARKER_END, MARKER_START } from './boot.ts';
import { pico2Firmware } from './rp2350.test-helper.ts';
import { parseUf2, UF2_FAMILY } from '@benchtop/core';

// BT65: finding the image definition the bootrom will enter, as its flash boot does.

function flashOf(uf2: Uint8Array): Uint8Array {
  const flash = new Uint8Array(0x400000).fill(0xff);
  for (const b of parseUf2(uf2).blocks) if (b.family === UF2_FAMILY.RP2350_RISCV) flash.set(b.data, b.address - 0x10000000);
  return flash;
}

/** A one-block image: IMAGE_TYPE `type`, optionally ENTRY_POINT. */
function block(type: number, entry?: [number, number]): Uint8Array {
  const words = [MARKER_START, (type << 16) | 0x0142];
  if (entry !== undefined) words.push(0x0344, entry[0], entry[1]);
  words.push(((words.length - 1) << 8) | 0xff, 0, MARKER_END);
  const flash = new Uint8Array(0x10000).fill(0xff);
  new Uint32Array(flash.buffer, 0x100, words.length).set(words);
  return flash;
}

describe('the image definition', () => {
  it('finds arduino-pico\'s OTA loader first: RISC-V on the RP2350, entered at 0x10000022 with sp 0x20082000', () => {
    const def = findImageDef(flashOf(pico2Firmware('blink')));
    expect(def).toMatchObject({ offset: 0, imageType: 0x1101, entry: 0x10000022, sp: 0x20082000 });
  });

  it('enters an image without ENTRY_POINT at the start of flash with sp at the top of SRAM', () => {
    expect(findImageDef(block(0x1101))).toMatchObject({ offset: 0x100, entry: 0x10000000, sp: 0x20082000 });
    expect(findImageDef(block(0x1101, [0x10000400, 0x20040000]))).toMatchObject({ entry: 0x10000400, sp: 0x20040000 });
  });

  it('refuses Arm and RP2040 images and empty flash with the reason', () => {
    expect(() => findImageDef(block(0x1001))).toThrow(/Arm cores; Benchtop runs its RISC-V cores/);
    expect(() => findImageDef(block(0x0101))).toThrow(/RP2040/);
    expect(() => findImageDef(new Uint8Array(0x10000).fill(0xff))).toThrow(BootError);
    expect(() => findImageDef(new Uint8Array(0x10000).fill(0xff))).toThrow(/BOOTSEL/);
  });
});
