/**
 * The ESP32-S2's peripheral space (BT148): 0x3F40_0000–0x3F4F_FFFF on the data bus (PeriBus1) and the
 * same registers at 0x6000_0000–0x600F_FFFF (PeriBus2), in 4 KB blocks, as the S3's map: each block
 * is a Peripheral; until a model replaces it, a RegisterFile with the S2 headers' reset values
 * (reg-defaults.generated.ts) answers, and accesses to it are unknown-register accesses — the first
 * 32 distinct addresses become `esp32s2-unimplemented-register` Problems (info). Nothing throws.
 * Blocks are registered and named by their PeriBus1 address.
 */

import { type Peripheral, ProblemLog } from '@benchtop/esp32';
import { RegisterFile } from '@benchtop/esp32c3';
import { PERIBUS1, PERIBUS_SIZE } from './memory.ts';
import { REG_DEFAULT_PAIRS } from './reg-defaults.generated.ts';

export const BLOCK_COUNT = PERIBUS_SIZE >>> 12;
export const CODE_S2_UNIMPLEMENTED = 'esp32s2-unimplemented-register';

const NAMES: [number, string][] = [
  [0x3f400000, 'UART0'], [0x3f402000, 'SPI1'], [0x3f403000, 'SPI0'], [0x3f404000, 'GPIO'], [0x3f405000, 'FE2'], [0x3f406000, 'FE'],
  [0x3f407000, 'FRC_TIMER'], [0x3f408000, 'RTC_CNTL'], [0x3f409000, 'IO_MUX'], [0x3f40b000, 'HINF'], [0x3f40e000, 'ANA_I2C'],
  [0x3f40f000, 'I2S0'], [0x3f410000, 'UART1'], [0x3f413000, 'I2C0'], [0x3f414000, 'UHCI0'], [0x3f415000, 'SLCHOST'],
  [0x3f416000, 'RMT'], [0x3f417000, 'PCNT'], [0x3f418000, 'SLC'], [0x3f419000, 'LEDC'], [0x3f41a000, 'EFUSE'],
  [0x3f41c000, 'NRX'], [0x3f41d000, 'BB'], [0x3f41f000, 'TIMG0'], [0x3f420000, 'TIMG1'], [0x3f421000, 'RTC_SLOWMEM'],
  [0x3f423000, 'SYSTIMER'], [0x3f424000, 'SPI2'], [0x3f425000, 'SPI3'], [0x3f426000, 'APB_CTRL'], [0x3f427000, 'I2C1'],
  [0x3f42b000, 'TWAI'], [0x3f435000, 'WDEV'], [0x3f437000, 'SPI4'], [0x3f439000, 'USB_WRAP'], [0x3f43a000, 'AES'],
  [0x3f43b000, 'SHA'], [0x3f43c000, 'RSA'], [0x3f43d000, 'DS'], [0x3f43e000, 'HMAC'], [0x3f43f000, 'CRYPTO_DMA'],
  [0x3f440000, 'APB_SARADC'], [0x3f480000, 'USB'], [0x3f4c0000, 'SYSTEM'], [0x3f4c1000, 'SENSITIVE'],
  [0x3f4c2000, 'INTERRUPT'], [0x3f4c3000, 'DMA_COPY'], [0x3f4ce000, 'ASSIST_DEBUG'], [0x3f4cf000, 'DEDICATED_GPIO'],
];

/** A PeriBus2 address's PeriBus1 twin (others unchanged). */
export const peribus1 = (address: number): number => (address >>> 0 >= 0x60000000 && address >>> 0 < 0x60100000 ? address - 0x60000000 + PERIBUS1 : address) >>> 0;

export function blockName(address: number): string {
  const a = peribus1(address);
  const base = (a & ~0xfff) >>> 0;
  if (base === 0x3f408000 && (a & 0xfff) >= 0x400) return (a & 0xfff) >= 0x800 ? ((a & 0xfff) >= 0xc00 ? 'RTC_I2C' : 'SENS') : 'RTC_IO';
  for (const [b, name] of NAMES) if (b === base) return name;
  return 'RESERVED';
}

let defaults: Map<number, number> | undefined;

/** The S2 header reset value of the register at `address` (either bus; 0 where the headers give none). */
export function registerDefault(address: number): number {
  if (defaults === undefined) {
    defaults = new Map();
    for (let i = 0; i < REG_DEFAULT_PAIRS.length; i += 2) defaults.set(REG_DEFAULT_PAIRS[i], REG_DEFAULT_PAIRS[i + 1]);
  }
  return defaults.get(peribus1(address)) ?? 0;
}

/** The radio's power-down controls every boot's rtc_init sets (BB, NRX, FE, FE2) — accesses that aren't a WiFi driver's. */
export function isRadioPowerControl(address: number): boolean {
  const a = (peribus1(address) & ~3) >>> 0;
  return a === 0x3f41d054 || a === 0x3f41ccd4 || a === 0x3f406090 || a === 0x3f4050f0;
}

export function isRadioBlock(address: number): boolean {
  const base = (peribus1(address) & ~0xfff) >>> 0;
  return base === 0x3f405000 || base === 0x3f406000 || base === 0x3f41c000 || base === 0x3f41d000;
}

const hex = (v: number): string => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

export class S2PeripheralMap {
  readonly blocks: Peripheral[] = [];
  readonly modeled = new Uint8Array(BLOCK_COUNT);
  readonly problems: ProblemLog;
  /** Accesses to radio blocks other than the power-down controls (a firmware running a WiFi driver). */
  radioAccesses = 0;
  /** BT150: each such access (the Mcu reports WiFi as not modeled yet). */
  onRadio: ((address: number, pc: number) => void) | null = null;

  constructor(problems: ProblemLog) {
    this.problems = problems;
    for (let i = 0; i < BLOCK_COUNT; i++) this.blocks.push(new RegisterFile(PERIBUS1 + i * 0x1000, registerDefault));
  }

  /** Registers a model at its PeriBus1 address (PeriBus2 reaches it too). */
  register(base: number, peripheral: Peripheral): void {
    const index = (peribus1(base) - PERIBUS1) >>> 12;
    this.blocks[index] = peripheral;
    this.modeled[index] = 1;
  }

  /** The RegisterFile behind an unmodeled block. */
  registers(base: number): RegisterFile {
    const block = this.blocks[(peribus1(base) - PERIBUS1) >>> 12];
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

  /** `address` on either peripheral bus. */
  read32(address: number, pc: number): number {
    const index = ((address >>> 0) & (PERIBUS_SIZE - 1)) >>> 12;
    const block = this.blocks[index];
    const value = block.read32(address & 0xffc) >>> 0;
    if (this.modeled[index] === 0 || (block.implements !== undefined && !block.implements(address & 0xffc))) this.unknown('read', address, value, pc);
    return value;
  }

  write32(address: number, value: number, pc: number): void {
    const index = ((address >>> 0) & (PERIBUS_SIZE - 1)) >>> 12;
    const block = this.blocks[index];
    block.write32(address & 0xffc, value >>> 0);
    if (this.modeled[index] === 0 || (block.implements !== undefined && !block.implements(address & 0xffc))) this.unknown('write', address, value, pc);
  }

  private unknown(access: 'read' | 'write', address: number, value: number, pc: number): void {
    if (isRadioBlock(address) && !isRadioPowerControl(address)) {
      this.radioAccesses++;
      this.onRadio?.(address, pc);
    }
    const a = peribus1(address);
    if (!this.problems.admit(CODE_S2_UNIMPLEMENTED, a)) return;
    const offset = `0x${(a & 0xfff).toString(16).toUpperCase().padStart(3, '0')}`;
    this.problems.add('info', CODE_S2_UNIMPLEMENTED, a, `${access} ${hex(address)} (${blockName(a)}+${offset}) = ${hex(value)} at PC ${hex(pc)}`);
  }
}
