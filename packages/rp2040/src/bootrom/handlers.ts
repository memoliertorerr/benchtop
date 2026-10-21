/**
 * What the bootrom's functions do (BT60), run in JS when the core executes a stub's BKPT inside
 * the ROM (layout.ts). Arguments and results follow the AAPCS: r0–r3 in, r0 (r0:r1) out. Each
 * call is charged the datasheet's average cycle count (tables 164, 169, 170; the bulk memory
 * and flash functions ≈ one cycle per word), so firmware sees plausible timing.
 *
 * Flash: the datasheet's flash functions take offsets from the start of flash; erase sets bytes
 * to 0xFF, program ANDs data in (flash bits only go 1 → 0). rp2040js serves XIP reads straight
 * from the flash array, so the XIP enter/exit/flush functions have nothing to do.
 */

import type { RP2040 } from 'rp2040js';
import { FP_CYCLES, runFloatFunction } from './float.ts';
import { ROM_CALL, romTableLookup } from './layout.ts';

const SRAM_START = 0x20000000;
const FLASH_START = 0x10000000;

/** What a ROM call may ask of the adapter. */
export interface RomHost {
  readonly rp2040: RP2040;
  /** Charges `cycles` more for the call (beyond the stub's two instructions). */
  charge(cycles: number): void;
  /** The reset handler: boot the loaded image (direct boot). */
  boot(): void;
  /** Stops the core with an emulation fault. */
  fault(message: string): void;
  /** reset_to_usb_boot: the chip would reboot into BOOTSEL mode. */
  usbBoot(activityPinMask: number, disableInterfaceMask: number): void;
}

const CYCLES: Readonly<Record<number, number>> = {
  [ROM_CALL.POPCOUNT32]: 20,
  [ROM_CALL.REVERSE32]: 22,
  [ROM_CALL.CLZ32]: 10,
  [ROM_CALL.CTZ32]: 11,
  [ROM_CALL.TABLE_LOOKUP]: 20,
};

function popcount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function reverse(v: number): number {
  v = ((v >>> 1) & 0x55555555) | ((v & 0x55555555) << 1);
  v = ((v >>> 2) & 0x33333333) | ((v & 0x33333333) << 2);
  v = ((v >>> 4) & 0x0f0f0f0f) | ((v & 0x0f0f0f0f) << 4);
  return (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0;
}

/** Fills [ptr, ptr + n) with byte c (SRAM directly, anything else through the bus). */
function memset(rp: RP2040, ptr: number, c: number, n: number): void {
  const offset = (ptr - SRAM_START) >>> 0;
  if (offset + n <= rp.sram.length) rp.sram.fill(c & 0xff, offset, offset + n);
  else for (let i = 0; i < n; i++) rp.writeUint8((ptr + i) >>> 0, c);
}

/** Copies n bytes from src to dest (SRAM and flash directly, anything else through the bus). */
function memcpy(rp: RP2040, dest: number, src: number, n: number): void {
  const d = (dest - SRAM_START) >>> 0;
  if (d + n <= rp.sram.length) {
    const s = (src - SRAM_START) >>> 0;
    if (s + n <= rp.sram.length) {
      rp.sram.copyWithin(d, s, s + n);
      return;
    }
    const f = (src - FLASH_START) >>> 0;
    if (f + n <= rp.flash.length) {
      rp.sram.set(rp.flash.subarray(f, f + n), d);
      return;
    }
  }
  for (let i = 0; i < n; i++) rp.writeUint8((dest + i) >>> 0, rp.readUint8((src + i) >>> 0));
}

/**
 * Runs ROM call `id` (the stub's BKPT immediate). Returns false when `id` isn't a ROM call
 * (the caller treats it as a real breakpoint).
 */
export function runRomCall(id: number, host: RomHost): boolean {
  const rp = host.rp2040;
  const r = rp.core.registers;
  if (id >= ROM_CALL.FLOAT_BASE && id < ROM_CALL.FLOAT_BASE + 64) {
    const single = id < ROM_CALL.DOUBLE_BASE;
    const offset = 4 * (id - (single ? ROM_CALL.FLOAT_BASE : ROM_CALL.DOUBLE_BASE));
    if (!runFloatFunction(offset, single, r)) {
      host.fault(`bootrom: no ${single ? 'float' : 'double'} function at table offset 0x${offset.toString(16)}`);
      return true;
    }
    const cycles = FP_CYCLES[offset];
    if (cycles !== undefined) host.charge(cycles[single ? 0 : 1] - 2);
    return true;
  }
  const extra = CYCLES[id];
  if (extra !== undefined) host.charge(extra - 2);
  switch (id) {
    case ROM_CALL.RESET:
      host.boot();
      return true;
    case ROM_CALL.NMI:
      host.fault('NMI taken while the bootrom\'s vector table was active');
      return true;
    case ROM_CALL.HARDFAULT:
      host.fault('HardFault taken while the bootrom\'s vector table was active');
      return true;
    case ROM_CALL.DEPRECATED:
      host.fault('a deprecated bootrom function was called');
      return true;
    case ROM_CALL.TABLE_LOOKUP:
      r[0] = romTableLookup((a) => rp.readUint16(a), r[0], r[1]);
      return true;
    case ROM_CALL.POPCOUNT32:
      r[0] = popcount(r[0]);
      return true;
    case ROM_CALL.REVERSE32:
      r[0] = reverse(r[0]);
      return true;
    case ROM_CALL.CLZ32:
      r[0] = Math.clz32(r[0]);
      return true;
    case ROM_CALL.CTZ32: {
      const v = r[0] | 0;
      r[0] = v === 0 ? 32 : 31 - Math.clz32(v & -v);
      return true;
    }
    case ROM_CALL.MEMSET:
    case ROM_CALL.MEMSET4:
      memset(rp, r[0], r[1], r[2]);
      host.charge(Math.ceil(r[2] / 4) + 8);
      return true; // r0 (ptr) is the result already
    case ROM_CALL.MEMCPY:
    case ROM_CALL.MEMCPY44:
      memcpy(rp, r[0], r[1], r[2]);
      host.charge(Math.ceil(r[2] / 4) * 2 + 8);
      return true;
    case ROM_CALL.CONNECT_INTERNAL_FLASH:
    case ROM_CALL.FLASH_EXIT_XIP:
    case ROM_CALL.FLASH_FLUSH_CACHE:
    case ROM_CALL.FLASH_ENTER_CMD_XIP:
      return true;
    case ROM_CALL.FLASH_RANGE_ERASE: {
      const start = r[0] >>> 0;
      const end = Math.min(rp.flash.length, start + (r[1] >>> 0));
      if (start < end) rp.flash.fill(0xff, start, end);
      host.charge(Math.max(0, end - start) >>> 2);
      return true;
    }
    case ROM_CALL.FLASH_RANGE_PROGRAM: {
      const start = r[0] >>> 0;
      const count = Math.max(0, Math.min(rp.flash.length - start, r[2] >>> 0));
      for (let i = 0; i < count; i++) rp.flash[start + i] &= rp.readUint8((r[1] + i) >>> 0);
      host.charge(count);
      return true;
    }
    case ROM_CALL.RESET_TO_USB_BOOT:
      host.usbBoot(r[0], r[1]);
      return true;
    case ROM_CALL.WAIT_FOR_VECTOR:
      host.fault('_wait_for_vector is core 1\'s: core 1 is not simulated');
      return true;
    default:
      return false;
  }
}
