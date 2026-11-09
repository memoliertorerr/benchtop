/**
 * The ESP32-S2's SYSTEM registers and cache controller (BT148; system_reg.h — DPORT_* names —,
 * extmem_reg.h).
 *
 * SYSTEM (0x3F4C_0000): the CPU clock — SYSCLK_CONF (0x8C) SOC_CLK_SEL (11:10: 0 XTAL /
 * (PRE_DIV_CNT + 1), 1 PLL, 2 RC_FAST 8 MHz / (PRE_DIV_CNT + 1), 3 APLL — taken as the PLL's) with
 * CPU_PER_CONF (0x18) CPUPERIOD_SEL under the PLL (0: 80 MHz, 1: 160 MHz, 2: 240 MHz); APB is
 * 80 MHz under the PLL, the CPU clock otherwise — `onClock` hears every change.
 * CPU_INTR_FROM_CPU_0..3 (0x58–0x64) bit 0 drive sources 28–31. RTC_FASTMEM_CONFIG / CRC
 * (0x78 / 0x7C): the RTC fast memory CRC unit, as the S3's (complete at once). The rest reads back.
 *
 * EXTMEM (0x6180_0000): the cache operations the ROM's Cache_* functions start and wait for —
 * PRO_DCACHE_CTRL (0x00) and PRO_ICACHE_CTRL (0x40) hold ENA/DONE pairs (invalidate 8/9, flush
 * 10/11, clean 12/13, autoload 18/19, preload 20/21, unlock 22/23, lock 24/25): each DONE bit reads
 * 1 (the operation completes at once); an ICache invalidate drops the core's predecoded flash
 * pages. PRO_CACHE_STATE (0x11C) says both caches are idle (ICACHE_STATE 11:0 and DCACHE_STATE
 * 23:12 read 1 — Cache_Suspend_ICache waits for it). The rest reads back (the cache itself isn't
 * modeled: no timing).
 */

import type { Peripheral } from '@benchtop/esp32';
import type { InterruptSource } from '@benchtop/esp32c3';
import { registerDefault } from './periph.ts';

export const SYSTEM_BASE = 0x3f4c0000;
export const EXTMEM_BASE = 0x61800000;
export const XTAL_HZ = 40_000_000;
const FROM_CPU_SOURCE = 28;

const CPU_PER_CONF = 0x018;
const FROM_CPU = 0x058;
const RTC_FASTMEM_CONFIG = 0x078;
const RTC_FASTMEM_CRC = 0x07c;
const SYSCLK_CONF = 0x08c;
const MEM_CRC_START = 1 << 8;
const MEM_CRC_FINISH = 1 << 31;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export class S2SystemRegs implements Peripheral {
  private readonly matrix: InterruptSource;
  private readonly rtcFast: Uint8Array;
  private readonly regs = new Uint32Array(1024);
  cpuHz = XTAL_HZ;
  apbHz = XTAL_HZ;
  onClock: ((cpuHz: number, apbHz: number) => void) | null = null;

  constructor(matrix: InterruptSource, rtcFast: Uint8Array) {
    this.matrix = matrix;
    this.rtcFast = rtcFast;
    this.systemReset();
  }

  systemReset(): void {
    for (let i = 0; i < this.regs.length; i++) this.regs[i] = registerDefault(SYSTEM_BASE + i * 4);
    for (let n = 0; n < 4; n++) this.matrix.setSource(FROM_CPU_SOURCE + n, false);
    this.updateClock();
  }

  private updateClock(): void {
    const sysclk = this.regs[SYSCLK_CONF >>> 2];
    const sel = (sysclk >>> 10) & 3;
    const div = (sysclk & 0x3ff) + 1;
    let cpu: number;
    let apb: number;
    if (sel === 1 || sel === 3) {
      const period = this.regs[CPU_PER_CONF >>> 2] & 3;
      cpu = period === 0 ? 80_000_000 : period === 1 ? 160_000_000 : 240_000_000;
      apb = 80_000_000;
    } else {
      cpu = (sel === 2 ? 8_000_000 : XTAL_HZ) / div;
      apb = cpu;
    }
    if (cpu === this.cpuHz && apb === this.apbHz) return;
    this.cpuHz = cpu;
    this.apbHz = apb;
    this.onClock?.(cpu, apb);
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    if (offset === RTC_FASTMEM_CONFIG) {
      this.memCrc(value);
      return;
    }
    if (offset === RTC_FASTMEM_CRC) return; // read-only
    this.regs[offset >>> 2] = value;
    if (offset === SYSCLK_CONF || offset === CPU_PER_CONF) this.updateClock();
    else if (offset >= FROM_CPU && offset < FROM_CPU + 16) this.matrix.setSource(FROM_CPU_SOURCE + ((offset - FROM_CPU) >>> 2), (value & 1) !== 0);
  }

  /** The CRC unit: bytes of RTC fast memory from word ADDR (19:9), LEN (30:20) words, CRC-32'd at once. */
  private memCrc(value: number): void {
    const conf = RTC_FASTMEM_CONFIG >>> 2;
    if ((value & MEM_CRC_START) === 0) {
      this.regs[conf] = value & ~MEM_CRC_FINISH;
      return;
    }
    const mem = this.rtcFast;
    const start = ((value >>> 9) & 0x7ff) * 4;
    const end = Math.min(mem.length, start + ((value >>> 20) & 0x7ff) * 4);
    let crc = 0xffffffff;
    for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ mem[i]) & 0xff] ^ (crc >>> 8);
    this.regs[RTC_FASTMEM_CRC >>> 2] = ~crc >>> 0;
    this.regs[conf] = (value | MEM_CRC_FINISH) >>> 0;
  }
}

/** PRO_DCACHE_CTRL and PRO_ICACHE_CTRL: their DONE bits (each ENA's next bit up). */
const DCACHE_CTRL = 0x00;
const ICACHE_CTRL = 0x40;
const DCACHE_DONE = (1 << 9) | (1 << 11) | (1 << 13) | (1 << 19) | (1 << 21) | (1 << 23) | (1 << 25);
const ICACHE_DONE = (1 << 9) | (1 << 19) | (1 << 21) | (1 << 23) | (1 << 25);
const ICACHE_INVALIDATE_ENA = 1 << 8;
const CACHE_STATE = 0x11c;
const CACHES_IDLE = 0x00001001;

export class S2Extmem implements Peripheral {
  private readonly regs = new Uint32Array(1024);
  /** The ROM's "invalidate the instruction cache": the core drops its predecoded flash pages. */
  onInvalidate: (() => void) | null = null;

  constructor() {
    this.systemReset();
  }

  systemReset(): void {
    this.regs.fill(0);
  }

  read32(offset: number): number {
    const v = this.regs[offset >>> 2];
    if (offset === DCACHE_CTRL) return (v | DCACHE_DONE) >>> 0;
    if (offset === ICACHE_CTRL) return (v | ICACHE_DONE) >>> 0;
    if (offset === CACHE_STATE) return CACHES_IDLE;
    return v;
  }

  write32(offset: number, value: number): void {
    this.regs[offset >>> 2] = value;
    if (offset === ICACHE_CTRL && (value & ICACHE_INVALIDATE_ENA) !== 0) this.onInvalidate?.();
  }
}
