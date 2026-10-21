/**
 * Small boot-time blocks:
 *
 * RegI2c — the internal analog I2C bus behind ROM rom_i2c_readReg/rom_i2c_writeReg (BBPLL, APLL,
 * bias blocks). Their ROM implementations (rom_chip_i2c_readReg 0x40004110,
 * rom_chip_i2c_writeReg 0x40004168, disassembled) use one word per host at
 * (host + 0x18003800) << 2 = 0x6000E000 + 4·host — the AHB alias of 0x3FF4E000: a write of
 * block | reg << 8 | data << 16 | 1 << 24 stores a byte, block | reg << 8 starts a read, and
 * both poll bit 25 (busy) before reading the byte back from bits 23:16. Modeled as a
 * [block][register] byte store that is never busy.
 *
 * Syscon — APB_CTRL/SYSCON (0x3FF66000): SYSCLK_CONF PRE_DIV_CNT divides XTAL/8M for the CPU
 * (a write recomputes the clocks); DATE (0x7C) keeps its reset value 0x16042000 (bit 31 = 0:
 * not ECO3). Rng — WDEV_RND_REG (0x3FF75144, AHB 0x60035144): a deterministic xorshift32.
 */

import type { SocContext } from './context.ts';
import { RegisterFile } from './periph.ts';

export const REGI2C_BASE = 0x3ff4e000;
const BUSY = 1 << 25;
const WRITE = 1 << 24;

export class RegI2c extends RegisterFile {
  /** store[block · 256 + register]. */
  readonly store = new Uint8Array(256 * 256);

  constructor() {
    super(REGI2C_BASE);
  }

  implements(offset: number): boolean {
    return offset < 0x40;
  }

  override write32(offset: number, value: number): void {
    const block = value & 0xff;
    const reg = (value >>> 8) & 0xff;
    if ((value & WRITE) !== 0) this.store[block * 256 + reg] = (value >>> 16) & 0xff;
    // The word reads back with the register's byte in 23:16 and busy (bit 25) clear.
    super.write32(offset, ((value & ~(BUSY | 0xff0000)) | (this.store[block * 256 + reg] << 16)) >>> 0);
  }

  /** A register byte (tests, and the clock tree reading back the PLL setup). */
  read(block: number, reg: number): number {
    return this.store[block * 256 + reg];
  }
}

export const SYSCON_BASE = 0x3ff66000;
const SYSCLK_CONF = 0x00;
const DATE = 0x7c;

export class Syscon extends RegisterFile {
  private readonly context: SocContext;

  constructor(context: SocContext) {
    super(SYSCON_BASE);
    this.context = context;
  }

  implements(offset: number): boolean {
    return offset === SYSCLK_CONF || offset === DATE;
  }

  /** SYSCLK_CONF PRE_DIV_CNT (bits 9:0). */
  preDivider(): number {
    return this.regs[SYSCLK_CONF >>> 2] & 0x3ff;
  }

  override write32(offset: number, value: number): void {
    if (offset === DATE) return;
    super.write32(offset, value);
    if (offset === SYSCLK_CONF) this.context.clockChanged();
  }
}

export const RNG_BASE = 0x3ff75000;
const RND = 0x144;

export class Rng extends RegisterFile {
  private state: number;

  constructor(seed = 0x2545f491) {
    super(RNG_BASE);
    this.state = seed >>> 0 || 1;
  }

  implements(offset: number): boolean {
    return offset === RND;
  }

  override read32(offset: number): number {
    if (offset !== RND) return super.read32(offset);
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }
}
