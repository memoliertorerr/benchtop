/**
 * The ESP32-C3's peripheral space, 0x6000_0000–0x600D_0FFF (soc.h's DR_REG_* bases), in 4 KB
 * blocks (BT92). As on the ESP32 (@benchtop/esp32's periph.ts): each block is a Peripheral; until
 * a model replaces it, a RegisterFile — the headers' reset values (reg-defaults.generated.ts) and
 * plain read-back — answers, and accesses to it are unknown-register accesses, the first 32
 * distinct addresses becoming `esp32c3-unimplemented-register` Problems (info: the boot touches
 * dozens of configuration registers that only need to read back). Nothing throws.
 *
 * BT107: the radio's blocks (isRadioBlock) report every access through `onRadio`, as the ESP32's
 * do — but the power-down controls every boot sets (isRadioPowerControl): a firmware touching the
 * rest runs the closed WiFi driver, which the simulator doesn't.
 */

import { type Peripheral, ProblemLog } from '@benchtop/esp32';
import { PERIPH_BASE, PERIPH_END } from './memory.ts';
import { REG_DEFAULT_PAIRS } from './reg-defaults.generated.ts';

export const BLOCK_COUNT = (PERIPH_END - PERIPH_BASE) >>> 12;
export const CODE_UNIMPLEMENTED = 'esp32c3-unimplemented-register';

const NAMES: [number, string][] = [
  [0x60000000, 'UART0'], [0x60002000, 'SPI1'], [0x60003000, 'SPI0'], [0x60004000, 'GPIO'], [0x60007000, 'TIMG?'],
  [0x60008000, 'RTC_CNTL'], [0x60009000, 'IO_MUX'], [0x6000e000, 'RTC_I2C'], [0x60010000, 'UART1'], [0x60013000, 'I2C0'],
  [0x60014000, 'UHCI0'], [0x60016000, 'RMT'], [0x60019000, 'LEDC'], [0x60005000, 'FE2'], [0x60006000, 'FE'], [0x6001c000, 'NRX'], [0x6001d000, 'BB'],
  [0x6001f000, 'TIMG0'], [0x60020000, 'TIMG1'], [0x60023000, 'SYSTIMER'], [0x60024000, 'SPI2'], [0x60026000, 'APB_CTRL'],
  [0x6002b000, 'TWAI'], [0x6002d000, 'I2S0'], [0x6003a000, 'AES'], [0x6003b000, 'SHA'], [0x6003c000, 'RSA'],
  [0x6003d000, 'DS'], [0x6003e000, 'HMAC'], [0x6003f000, 'GDMA'], [0x60040000, 'APB_SARADC'], [0x60043000, 'USB_SERIAL_JTAG'],
  [0x600c0000, 'SYSTEM'], [0x600c1000, 'SENSITIVE'], [0x600c2000, 'INTERRUPT'], [0x600c4000, 'EXTMEM'], [0x600c5000, 'MMU_TABLE'],
  [0x600cc000, 'AES_XTS'], [0x600ce000, 'ASSIST_DEBUG'], [0x600cf000, 'DEDICATED_GPIO'], [0x600d0000, 'WORLD_CNTL'],
];

export function blockName(address: number): string {
  const base = (address & ~0xfff) >>> 0;
  if (base === 0x60008000 && (address & 0xfff) >= 0x800) return 'EFUSE';
  for (const [b, name] of NAMES) if (b === base) return name;
  return 'RESERVED';
}

let defaults: Map<number, number> | undefined;

/** Header reset value of the register at `address` (0 where the headers give none). */
export function registerDefault(address: number): number {
  if (defaults === undefined) {
    defaults = new Map();
    for (let i = 0; i < REG_DEFAULT_PAIRS.length; i += 2) defaults.set(REG_DEFAULT_PAIRS[i], REG_DEFAULT_PAIRS[i + 1]);
  }
  return defaults.get(address >>> 0) ?? 0;
}

/** A 4 KB block of plain registers: reset values from the headers, writes read back. */
export class RegisterFile implements Peripheral {
  readonly regs = new Uint32Array(1024);
  readonly base: number;
  /** BT124: the chip's register defaults (the S3 passes its own). */
  private readonly defaults: (address: number) => number;

  constructor(base: number, defaults: (address: number) => number = registerDefault) {
    this.base = base;
    this.defaults = defaults;
    this.reset();
  }

  reset(): void {
    for (let i = 0; i < 1024; i++) this.regs[i] = this.defaults(this.base + i * 4);
  }

  systemReset(_rtcDomain: boolean): void {
    this.reset();
  }

  read32(offset: number): number {
    return this.regs[offset >>> 2];
  }

  write32(offset: number, value: number): void {
    this.regs[offset >>> 2] = value;
  }
}

/**
 * BT107: the radio's register blocks — FE2 0x60005000, FE 0x60006000, NRX 0x6001C000 (its
 * registers from 0x6001CC00), BB 0x6001D000 (soc.h's DR_REG_*_BASE). The closed WiFi driver's PHY
 * setup touches them (then polls the analog through RTC_I2C forever); a firmware whose WiFi calls
 * are answered at the API never does.
 */
export function isRadioBlock(address: number): boolean {
  const base = (address & ~0xfff) >>> 0;
  return base === 0x60005000 || base === 0x60006000 || base === 0x6001c000 || base === 0x6001d000;
}

/**
 * The radio's power-down controls, which every boot's rtc_init sets (rtc_sleep_pu: BB_BBPD_CTRL,
 * NRX's NRXPD_CTRL, FE_GEN_CTRL, FE2_TX_INTERP_CTRL) — accesses that aren't the WiFi driver's.
 */
export function isRadioPowerControl(address: number): boolean {
  const a = (address & ~3) >>> 0;
  return a === 0x6001d054 || a === 0x6001ccd4 || a === 0x60006090 || a === 0x600050f0;
}

const hex = (v: number): string => `0x${(v >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

export class PeripheralMap {
  readonly blocks: Peripheral[] = [];
  readonly modeled = new Uint8Array(BLOCK_COUNT);
  readonly problems: ProblemLog;
  /** BT107: called on every access to a radio block (isRadioBlock, but not isRadioPowerControl) — unmodeled, so never in a hot path. */
  onRadio: ((address: number, pc: number) => void) | null = null;
  /** Accesses to radio blocks (tests assert none with WiFi answered at its API). */
  radioAccesses = 0;
  private readonly radio = new Uint8Array(BLOCK_COUNT);

  constructor(problems: ProblemLog) {
    this.problems = problems;
    for (let i = 0; i < BLOCK_COUNT; i++) {
      this.blocks.push(new RegisterFile(PERIPH_BASE + i * 0x1000));
      this.radio[i] = isRadioBlock(PERIPH_BASE + i * 0x1000) ? 1 : 0;
    }
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
    if (this.radio[(address - PERIPH_BASE) >>> 12] !== 0 && !isRadioPowerControl(address)) {
      this.radioAccesses++;
      this.onRadio?.(address, pc);
    }
    if (!this.problems.admit(CODE_UNIMPLEMENTED, address)) return;
    const offset = `0x${(address & 0xfff).toString(16).toUpperCase().padStart(3, '0')}`;
    this.problems.add('info', CODE_UNIMPLEMENTED, address, `${access} ${hex(address)} (${blockName(address)}+${offset}) = ${hex(value)} at PC ${hex(pc)}`);
  }
}

export { ProblemLog };
