/**
 * The ESP32-S3's peripheral space, 0x6000_0000–0x600D_0FFF (soc.h's DR_REG_* bases), in 4 KB
 * blocks (BT124), as the C3's (@benchtop/esp32c3 periph.ts): each block is a Peripheral; until a
 * model replaces it, a RegisterFile with the S3 headers' reset values (reg-defaults.generated.ts)
 * answers, and accesses to it are unknown-register accesses — the first 32 distinct addresses
 * become `esp32s3-unimplemented-register` Problems (info). Nothing throws.
 */

import { type Peripheral, ProblemLog } from '@benchtop/esp32';
import { RegisterFile } from '@benchtop/esp32c3';
import { PERIPH_BASE, PERIPH_END } from './memory.ts';
import { REG_DEFAULT_PAIRS } from './reg-defaults.generated.ts';

export const BLOCK_COUNT = (PERIPH_END - PERIPH_BASE) >>> 12;
export const CODE_S3_UNIMPLEMENTED = 'esp32s3-unimplemented-register';

const NAMES: [number, string][] = [
  [0x60000000, 'UART0'], [0x60002000, 'SPI1'], [0x60003000, 'SPI0'], [0x60004000, 'GPIO'], [0x60005000, 'FE2'], [0x60006000, 'FE'],
  [0x60007000, 'EFUSE'], [0x60008000, 'RTC_CNTL'], [0x60009000, 'IO_MUX'], [0x6000e000, 'ANA_I2C'], [0x6000b000, 'HINF'], [0x6000c000, 'UHCI1'],
  [0x6000f000, 'I2S0'], [0x60010000, 'UART1'], [0x60011000, 'BT'], [0x60013000, 'I2C0'], [0x60014000, 'UHCI0'],
  [0x60015000, 'SLCHOST'], [0x60016000, 'RMT'], [0x60017000, 'PCNT'], [0x60018000, 'SLC'], [0x60019000, 'LEDC'],
  [0x6001c000, 'NRX'], [0x6001d000, 'BB'], [0x6001e000, 'MCPWM0'], [0x6001f000, 'TIMG0'], [0x60020000, 'TIMG1'],
  [0x60021000, 'RTC_SLOWMEM'], [0x60023000, 'SYSTIMER'], [0x60024000, 'SPI2'], [0x60025000, 'SPI3'], [0x60026000, 'APB_CTRL'],
  [0x60027000, 'I2C1'], [0x60028000, 'SDMMC'], [0x6002a000, 'PERI_BACKUP'], [0x6002b000, 'TWAI'], [0x6002c000, 'MCPWM1'],
  [0x6002d000, 'I2S1'], [0x6002e000, 'UART2'], [0x60038000, 'USB_SERIAL_JTAG'], [0x60039000, 'USB_WRAP'], [0x6003a000, 'AES'],
  [0x6003b000, 'SHA'], [0x6003c000, 'RSA'], [0x6003d000, 'DS'], [0x6003e000, 'HMAC'], [0x6003f000, 'GDMA'],
  [0x60040000, 'APB_SARADC'], [0x60041000, 'LCD_CAM'], [0x600c0000, 'SYSTEM'], [0x600c1000, 'SENSITIVE'], [0x600c2000, 'INTERRUPT'],
  [0x600c4000, 'EXTMEM'], [0x600c5000, 'MMU_TABLE'], [0x600ce000, 'ASSIST_DEBUG'], [0x600d0000, 'WORLD_CNTL'],
];

export function blockName(address: number): string {
  const base = (address & ~0xfff) >>> 0;
  if (base === 0x60008000 && (address & 0xfff) >= 0x400) return (address & 0xfff) >= 0x800 ? ((address & 0xfff) >= 0xc00 ? 'RTC_I2C' : 'SENS') : 'RTC_IO';
  for (const [b, name] of NAMES) if (b === base) return name;
  return 'RESERVED';
}

let defaults: Map<number, number> | undefined;

/** The S3 header reset value of the register at `address` (0 where the headers give none). */
export function registerDefault(address: number): number {
  if (defaults === undefined) {
    defaults = new Map();
    for (let i = 0; i < REG_DEFAULT_PAIRS.length; i += 2) defaults.set(REG_DEFAULT_PAIRS[i], REG_DEFAULT_PAIRS[i + 1]);
  }
  return defaults.get(address >>> 0) ?? 0;
}

/**
 * The radio's power-down controls every boot's rtc_init sets (as the C3's: BB, NRX, FE, FE2 —
 * the same addresses on the S3) — accesses that aren't a WiFi driver's.
 */
export function isRadioPowerControl(address: number): boolean {
  const a = (address & ~3) >>> 0;
  return a === 0x6001d054 || a === 0x6001ccd4 || a === 0x60006090 || a === 0x600050f0;
}

export function isRadioBlock(address: number): boolean {
  const base = (address & ~0xfff) >>> 0;
  return base === 0x60005000 || base === 0x60006000 || base === 0x6001c000 || base === 0x6001d000;
}

const hex = (v: number): string => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

export class S3PeripheralMap {
  readonly blocks: Peripheral[] = [];
  readonly modeled = new Uint8Array(BLOCK_COUNT);
  readonly problems: ProblemLog;
  /** Accesses to radio blocks other than the power-down controls (a firmware running a WiFi driver). */
  radioAccesses = 0;
  /** BT127: called on each such access — unmodeled blocks, so never in a hot path. */
  onRadio: ((address: number, pc: number) => void) | null = null;

  constructor(problems: ProblemLog) {
    this.problems = problems;
    for (let i = 0; i < BLOCK_COUNT; i++) this.blocks.push(new RegisterFile(PERIPH_BASE + i * 0x1000, registerDefault));
  }

  register(base: number, peripheral: Peripheral): void {
    const index = (base - PERIPH_BASE) >>> 12;
    this.blocks[index] = peripheral;
    this.modeled[index] = 1;
  }

  /** The RegisterFile behind an unmodeled block. */
  registers(base: number): RegisterFile {
    const block = this.blocks[(base - PERIPH_BASE) >>> 12];
    if (!(block instanceof RegisterFile)) throw new Error(`0x${base.toString(16)} is modeled`);
    return block;
  }

  systemReset(rtcDomain: boolean): void {
    const done = new Set<Peripheral>();
    for (const block of this.blocks) {
      if (done.has(block)) continue;
      done.add(block);
      block.systemReset?.(rtcDomain);
    }
  }

  read32(address: number, pc: number): number {
    const index = (address - PERIPH_BASE) >>> 12;
    const block = this.blocks[index];
    const value = block.read32(address & 0xffc) >>> 0;
    if (this.modeled[index] === 0 || (block.implements !== undefined && !block.implements(address & 0xffc))) this.unknown('read', address, value, pc);
    return value;
  }

  write32(address: number, value: number, pc: number): void {
    const index = (address - PERIPH_BASE) >>> 12;
    const block = this.blocks[index];
    block.write32(address & 0xffc, value >>> 0);
    if (this.modeled[index] === 0 || (block.implements !== undefined && !block.implements(address & 0xffc))) this.unknown('write', address, value, pc);
  }

  private unknown(access: 'read' | 'write', address: number, value: number, pc: number): void {
    if (isRadioBlock(address) && !isRadioPowerControl(address)) {
      this.radioAccesses++;
      this.onRadio?.(address, pc);
    }
    if (!this.problems.admit(CODE_S3_UNIMPLEMENTED, address)) return;
    const offset = `0x${(address & 0xfff).toString(16).toUpperCase().padStart(3, '0')}`;
    this.problems.add('info', CODE_S3_UNIMPLEMENTED, address, `${access} ${hex(address)} (${blockName(address)}+${offset}) = ${hex(value)} at PC ${hex(pc)}`);
  }
}
