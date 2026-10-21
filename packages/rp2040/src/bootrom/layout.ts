/**
 * Benchtop's own RP2040 bootrom image (BT60), written from the RP2040 datasheet §2.8.3: the real
 * bootrom isn't used — its floating point library may only run on an RP2040 device (or under
 * GPLv2). The fixed header sits where the datasheet's table 163 puts it; everything behind the
 * lookup tables is ours. Each function is a 4-byte Thumb stub, `bkpt #id; bx lr`: the adapter
 * catches a BKPT inside the ROM (rp2040js's onBreak) and runs the function in JS (handlers.ts),
 * then the `bx lr` returns to the caller.
 *
 *   0x0000  initial SP (0x20042000), reset, NMI and HardFault handlers (stubs)
 *   0x0010  'M', 'u', 0x01, version 3 (the B2 silicon's bootrom version)
 *   0x0014  16-bit pointers: function table, data table, rom_table_lookup
 *   0x0100  stubs; 0x0800 function table; 0x0880 data table; 0x0a00/0x0b00 the soft float and
 *           soft double tables, each preceded (at table − 2) by its size in words, which the
 *           SDK checks; 0x0c00 the copyright string, 0x0c80 the git revision word;
 *           0x0d00 debug_trampoline (real Thumb: blx r7; bkpt #0).
 */

import { FP_OFFSETS } from './float.ts';

export const ROM_SIZE = 0x4000;
export const ROM_VERSION = 3;
export const BOOT_STACK = 0x20042000;

/** BKPT immediates of the stubs (imm8). 0 is never ours: it's the debugger's (and the trampoline's). */
export const ROM_CALL = {
  RESET: 0x01,
  NMI: 0x02,
  HARDFAULT: 0x03,
  TABLE_LOOKUP: 0x04,
  DEPRECATED: 0x05,
  POPCOUNT32: 0x10,
  REVERSE32: 0x11,
  CLZ32: 0x12,
  CTZ32: 0x13,
  MEMSET: 0x14,
  MEMSET4: 0x15,
  MEMCPY: 0x16,
  MEMCPY44: 0x17,
  CONNECT_INTERNAL_FLASH: 0x18,
  FLASH_EXIT_XIP: 0x19,
  FLASH_RANGE_ERASE: 0x1a,
  FLASH_RANGE_PROGRAM: 0x1b,
  FLASH_FLUSH_CACHE: 0x1c,
  FLASH_ENTER_CMD_XIP: 0x1d,
  RESET_TO_USB_BOOT: 0x1e,
  WAIT_FOR_VECTOR: 0x1f,
  /** 0x40 + offset/4: the soft float table's functions; 0x60 + offset/4: the soft double table's. */
  FLOAT_BASE: 0x40,
  DOUBLE_BASE: 0x60,
} as const;

/** Two-character table code (datasheet: rom_table_code(c1, c2) = c2 << 8 | c1). */
export function romCode(code: string): number {
  return code.charCodeAt(0) | (code.charCodeAt(1) << 8);
}

const STUBS = 0x0100;
const FUNC_TABLE = 0x0800;
const DATA_TABLE = 0x0880;
export const SF_TABLE = 0x0a00;
export const SD_TABLE = 0x0b00;
const COPYRIGHT = 0x0c00;
const GIT_REVISION = 0x0c80;
export const DEBUG_TRAMPOLINE = 0x0d00;
export const DEBUG_TRAMPOLINE_END = 0x0d02;
const TABLE_WORDS = 32;

/** The functions the function table lists: code → stub id. */
const FUNCTIONS: readonly [string, number][] = [
  ['P3', ROM_CALL.POPCOUNT32],
  ['R3', ROM_CALL.REVERSE32],
  ['L3', ROM_CALL.CLZ32],
  ['T3', ROM_CALL.CTZ32],
  ['MS', ROM_CALL.MEMSET],
  ['S4', ROM_CALL.MEMSET4],
  ['MC', ROM_CALL.MEMCPY],
  ['C4', ROM_CALL.MEMCPY44],
  ['IF', ROM_CALL.CONNECT_INTERNAL_FLASH],
  ['EX', ROM_CALL.FLASH_EXIT_XIP],
  ['RE', ROM_CALL.FLASH_RANGE_ERASE],
  ['RP', ROM_CALL.FLASH_RANGE_PROGRAM],
  ['FC', ROM_CALL.FLASH_FLUSH_CACHE],
  ['CX', ROM_CALL.FLASH_ENTER_CMD_XIP],
  ['UB', ROM_CALL.RESET_TO_USB_BOOT],
  ['WV', ROM_CALL.WAIT_FOR_VECTOR],
];

export interface BootromLayout {
  /** The 16 KB image, as rp2040js's `loadBootrom` takes it. */
  image: Uint32Array;
  /** Thumb address (bit 0 set) of each stub, by BKPT id. */
  stubs: ReadonlyMap<number, number>;
  /** Where the float stubs start and end (the 'FS'/'FE' data entries). */
  fplibStart: number;
  fplibEnd: number;
}

/** Builds the ROM image. */
export function buildBootrom(): BootromLayout {
  const image = new Uint32Array(ROM_SIZE / 4);
  const bytes = new Uint8Array(image.buffer);
  const view = new DataView(image.buffer);
  const half = (at: number, v: number): void => view.setUint16(at, v, true);
  const word = (at: number, v: number): void => view.setUint32(at, v >>> 0, true);

  const stubs = new Map<number, number>();
  let next = STUBS;
  const stub = (id: number, tail: number): number => {
    half(next, 0xbe00 | id); // bkpt #id
    half(next + 2, tail); // bx lr (0x4770), or b . (0xe7fe) for the handlers that never return
    const address = next | 1;
    stubs.set(id, address);
    next += 4;
    return address;
  };
  const BX_LR = 0x4770;
  const B_SELF = 0xe7fe;

  word(0x00, BOOT_STACK);
  word(0x04, stub(ROM_CALL.RESET, B_SELF));
  word(0x08, stub(ROM_CALL.NMI, B_SELF));
  word(0x0c, stub(ROM_CALL.HARDFAULT, B_SELF));
  bytes.set([0x4d, 0x75, 0x01, ROM_VERSION], 0x10); // 'M', 'u', 0x01, version
  half(0x14, FUNC_TABLE);
  half(0x16, DATA_TABLE);
  half(0x18, stub(ROM_CALL.TABLE_LOOKUP, BX_LR));
  const deprecated = stub(ROM_CALL.DEPRECATED, BX_LR);

  let at = FUNC_TABLE;
  for (const [code, id] of FUNCTIONS) {
    half(at, romCode(code));
    half(at + 2, stub(id, BX_LR));
    at += 4;
  }
  half(at, 0);

  // The soft float and soft double tables: 32 word entries each; table − 2 holds the size in
  // words (the SDK asserts it is ≥ 32 before copying the V2 table).
  const fplibStart = next;
  for (const [table, base] of [
    [SF_TABLE, ROM_CALL.FLOAT_BASE],
    [SD_TABLE, ROM_CALL.DOUBLE_BASE],
  ] as const) {
    bytes[table - 2] = TABLE_WORDS;
    for (let i = 0; i < TABLE_WORDS; i++) word(table + 4 * i, FP_OFFSETS.includes(4 * i) ? stub(base + i, BX_LR) : deprecated);
  }
  const fplibEnd = next;

  const copyright = '(C) Benchtop: a clean-room RP2040 bootrom for simulation';
  for (let i = 0; i < copyright.length; i++) bytes[COPYRIGHT + i] = copyright.charCodeAt(i);
  word(GIT_REVISION, 0x00000000);
  half(DEBUG_TRAMPOLINE, 0x47b8); // blx r7
  half(DEBUG_TRAMPOLINE_END, 0xbe00); // bkpt #0

  at = DATA_TABLE;
  for (const [code, value] of [
    ['CR', COPYRIGHT],
    ['GR', GIT_REVISION],
    ['FS', fplibStart],
    ['SF', SF_TABLE],
    ['FE', fplibEnd],
    ['SD', SD_TABLE],
  ] as const) {
    half(at, romCode(code));
    half(at + 2, value);
    at += 4;
  }
  half(at, 0);
  // The debug trampoline is a function too, but its table entries are plain addresses.
  at = FUNC_TABLE + 4 * FUNCTIONS.length;
  half(at, romCode('DT'));
  half(at + 2, DEBUG_TRAMPOLINE | 1);
  half(at + 4, romCode('DE'));
  half(at + 6, DEBUG_TRAMPOLINE_END);
  half(at + 8, 0);
  if (next > FUNC_TABLE) throw new Error('bootrom stubs overflow into the function table');
  return { image, stubs, fplibStart, fplibEnd };
}

/** Looks a code up in a ROM table (pairs of 16-bit code, 16-bit value; 0 ends it), as rom_table_lookup does. */
export function romTableLookup(read16: (address: number) => number, table: number, code: number): number {
  for (let at = table; at < ROM_SIZE; at += 4) {
    const entry = read16(at);
    if (entry === 0) return 0;
    if (entry === (code & 0xffff)) return read16(at + 2);
  }
  return 0;
}
