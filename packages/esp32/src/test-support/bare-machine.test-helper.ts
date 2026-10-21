/**
 * BareMachine (tests only): an Xtensa core with nothing around it but 128 KB of IRAM at
 * 0x40080000 and 192 KB of DRAM at 0x3FFB0000 as plain arrays — plus, with `{ rom: true }`, the
 * cached ESP32 ROM's sections (vectors, .text, .bt_text) read-only at 0x40000000–0x4006FFFF,
 * so ROM routines and the ROM's own window vectors (VECBASE's reset value) run. It loads a
 * fixtures/xtensa/<name>.bin
 * at 0x40080000 and runs from there until `break 1, 15` (halt), a fault, or a step cap (fault
 * "step cap"). `break 1, 14` is a checkpoint when `checkpoint` is set: the callback runs (to
 * pulse an interrupt line, say) and the program continues after the BREAK. Accesses outside the
 * two regions raise InstructionFetchError (2) or LoadStoreError (3). It supports the predecode
 * cache (BT37): IRAM and ROM pages are plain code, and a store to IRAM drops the cached page.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { type XtensaBus, XtensaBusError } from '../xtensa/bus.ts';
import { parseRomElf } from '../boot/rom.ts';
import { HALT, XtensaCore } from '../xtensa/cpu.ts';
import { EXCCAUSE } from '../xtensa/exceptions.ts';
import { CODE_NONE, CODE_PLAIN, type CodeBus } from '../xtensa/icache.ts';
import { loadCachedRom } from './rom.test-helper.ts';

export const IRAM_BASE = 0x40080000;
export const IRAM_SIZE = 128 * 1024;
export const DRAM_BASE = 0x3ffb0000;
export const DRAM_SIZE = 192 * 1024;
export const ROM_BASE = 0x40000000;
export const ROM_SIZE = 0x70000;

let romImage: Uint8Array | undefined;

/** The ROM's loadable sections laid out from ROM_BASE (parsed once per test file). */
function romBytes(): Uint8Array {
  if (romImage === undefined) {
    const image = new Uint8Array(ROM_SIZE + 2);
    for (const segment of parseRomElf(loadCachedRom()).segments) {
      const offset = segment.address - ROM_BASE;
      if (offset >= 0 && offset + segment.data.length <= ROM_SIZE) image.set(segment.data, offset);
    }
    romImage = image;
  }
  return romImage;
}

class BareBus implements XtensaBus, CodeBus {
  readonly iram = new Uint8Array(IRAM_SIZE + 2); // + 2: a fetch near the end reads zeros
  readonly dram = new Uint8Array(DRAM_SIZE);
  readonly rom: Uint8Array | null;
  /** The core on this bus (its predecode cache drops IRAM pages the program stores to). */
  core: XtensaCore | null = null;

  constructor(rom: Uint8Array | null) {
    this.rom = rom;
  }

  read8(addr: number): number {
    const a = addr >>> 0;
    if (((a - IRAM_BASE) >>> 0) < IRAM_SIZE) return this.iram[a - IRAM_BASE];
    if (((a - DRAM_BASE) >>> 0) < DRAM_SIZE) return this.dram[a - DRAM_BASE];
    if (this.rom !== null && ((a - ROM_BASE) >>> 0) < ROM_SIZE) return this.rom[a - ROM_BASE];
    throw new XtensaBusError('unmapped load', a, EXCCAUSE.LOAD_STORE_ERROR);
  }

  read16(addr: number): number {
    return this.read8(addr) | (this.read8(addr + 1) << 8);
  }

  read32(addr: number): number {
    return (this.read16(addr) | (this.read16(addr + 2) << 16)) >>> 0;
  }

  write8(addr: number, value: number): void {
    const a = addr >>> 0;
    if (((a - IRAM_BASE) >>> 0) < IRAM_SIZE) {
      this.iram[a - IRAM_BASE] = value;
      this.core?.icache.invalidatePage((a & ~0xfff) >>> 0);
    } else if (((a - DRAM_BASE) >>> 0) < DRAM_SIZE) this.dram[a - DRAM_BASE] = value;
    else throw new XtensaBusError('unmapped store', a, EXCCAUSE.LOAD_STORE_ERROR);
  }

  write16(addr: number, value: number): void {
    this.write8(addr, value & 0xff);
    this.write8(addr + 1, (value >>> 8) & 0xff);
  }

  write32(addr: number, value: number): void {
    this.write16(addr, value & 0xffff);
    this.write16(addr + 2, value >>> 16);
  }

  fetch(addr: number): number {
    const o = (addr >>> 0) - IRAM_BASE;
    if (o >= 0 && o < IRAM_SIZE) {
      const m = this.iram;
      return m[o] | (m[o + 1] << 8) | (m[o + 2] << 16);
    }
    const r = (addr >>> 0) - ROM_BASE;
    if (this.rom !== null && r >= 0 && r < ROM_SIZE) {
      const m = this.rom;
      return m[r] | (m[r + 1] << 8) | (m[r + 2] << 16);
    }
    throw new XtensaBusError('unmapped fetch', addr, EXCCAUSE.INSTRUCTION_FETCH_ERROR);
  }

  codePage(address: number): number {
    if (((address - IRAM_BASE) >>> 0) < IRAM_SIZE) return CODE_PLAIN;
    if (this.rom !== null && ((address - ROM_BASE) >>> 0) < ROM_SIZE) return CODE_PLAIN;
    return CODE_NONE;
  }

  codeByte(address: number): number {
    const o = address - IRAM_BASE;
    if (o >= 0 && o < IRAM_SIZE) return this.iram[o];
    return this.rom === null ? 0 : this.rom[address - ROM_BASE];
  }

  codeFetched(): void {}
}

export interface BareMachineOptions {
  /** Map the cached ESP32 ROM at 0x40000000 (read-only). */
  rom?: boolean;
}

/** The address of `symbol` in fixtures/xtensa/<program>.lst (a `.global` label in the .S). */
export function symbolAddress(program: string, symbol: string): number {
  const listing = readFileSync(join(REPO_ROOT, 'fixtures', 'xtensa', `${program}.lst`), 'utf8');
  const match = new RegExp(`^([0-9a-f]{8}) <${symbol}>:`, 'm').exec(listing);
  if (match === null) throw new Error(`${symbol} is not in ${program}.lst`);
  return Number.parseInt(match[1], 16);
}

export class BareMachine {
  readonly bus: BareBus;
  readonly core: XtensaCore;
  /** Runs at each `break 1, 14`; the program then continues after it. */
  checkpoint: ((machine: BareMachine) => void) | null = null;

  constructor(options: BareMachineOptions = {}) {
    this.bus = new BareBus(options.rom === true ? romBytes() : null);
    this.core = new XtensaCore(this.bus);
    this.bus.core = this.core;
    // `break 1, 15` ends a test program, `break 1, 14` is a checkpoint (when one is set); any
    // other BREAK is a debug exception.
    this.core.breakHook = (s, t) => s === 1 && (t === 15 || (t === 14 && this.checkpoint !== null));
  }

  /** Writes `bytes` into IRAM at `offset` (like `bus.iram.set`), dropping predecoded code there. */
  setIram(bytes: ArrayLike<number>, offset = 0): void {
    this.bus.iram.set(bytes, offset);
    for (let page = offset & ~0xfff; page < offset + bytes.length; page += 0x1000) this.core.icache.invalidatePage(IRAM_BASE + page);
  }

  /** fixtures/xtensa/<name>.bin at 0x40080000, PC there. */
  static load(name: string, options: BareMachineOptions = {}): BareMachine {
    const machine = new BareMachine(options);
    const bin = readFileSync(join(REPO_ROOT, 'fixtures', 'xtensa', `${name}.bin`));
    machine.bus.iram.set(bin);
    machine.core.pc = IRAM_BASE;
    return machine;
  }

  /** Runs until a halt; a run past `maxSteps` is a fault ("step cap"). Returns the core. */
  run(maxSteps = 10_000_000): XtensaCore {
    const core = this.core;
    const end = core.cycles + maxSteps;
    core.run(maxSteps);
    while (core.halt === HALT.BREAK && core.haltReason === '1, 14' && this.checkpoint !== null) {
      this.checkpoint(this);
      core.halt = HALT.RUNNING;
      core.haltReason = '';
      core.pc = (core.pc + 3) >>> 0; // past the 3-byte BREAK
      core.run(end - core.cycles);
    }
    if (core.halt === HALT.RUNNING) {
      core.halt = HALT.FAULT;
      core.haltReason = 'step cap';
    }
    return core;
  }

  /** Logical register aN. */
  a(n: number): number {
    return this.core.reg(n);
  }

  read32(addr: number): number {
    return this.bus.read32(addr);
  }

  read8(addr: number): number {
    return this.bus.read8(addr);
  }
}
