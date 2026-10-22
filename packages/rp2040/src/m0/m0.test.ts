import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFixture, REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { cachedMicroPython, micropythonFixture } from '../micropython.test-helper.ts';
import { createRp2040Mcu, type Rp2040Mcu } from '../rp2040-mcu.ts';
import { classify, OP, OP_OF } from './fast-core.ts';

// BT75: the predecoded core against rp2040js's own, in lockstep. Two chips run the same firmware
// with the same inputs — one on the stock CortexM0Core, one on FastM0Core — one instruction at a
// time (the adapter's stepCore0: PIO and the clock move with it); after every instruction their
// registers, flags, exception state and cycle counts must be equal.

interface Pair {
  stock: Rp2040Mcu;
  fast: Rp2040Mcu;
}

function pair(load: (mcu: Rp2040Mcu) => void, options: { micropython?: Uint8Array } = {}): Pair {
  const stock = createRp2040Mcu({ ...options, core: 'stock' });
  const fast = createRp2040Mcu({ ...options, core: 'fast' });
  load(stock);
  load(fast);
  return { stock, fast };
}

/** The state both cores must agree on, as one string (only built when they differ). */
function state(mcu: Rp2040Mcu): string {
  const c = mcu.rp.core;
  return `r=${[...c.registers].map((v) => v.toString(16)).join(',')} NZCV=${+c.N}${+c.Z}${+c.C}${+c.V} PM=${+c.PM} IPSR=${c.IPSR} SPSEL=${c.SPSEL} banked=${c.bankedSP.toString(16)} cycles=${c.cycles} waiting=${c.waiting} pending=${c.pendingInterrupts}`;
}

function same(a: Rp2040Mcu, b: Rp2040Mcu): boolean {
  const x = a.rp.core;
  const y = b.rp.core;
  for (let i = 0; i < 16; i++) if (x.registers[i] !== y.registers[i]) return false;
  return x.N === y.N && x.Z === y.Z && x.C === y.C && x.V === y.V && x.PM === y.PM && x.IPSR === y.IPSR && x.SPSEL === y.SPSEL && x.bankedSP === y.bankedSP && x.cycles === y.cycles && x.waiting === y.waiting && x.pendingInterrupts === y.pendingInterrupts;
}

/**
 * Steps both `count` times; the first difference fails with both states and the instruction
 * before it. Returns the instructions both executed (a step asleep in WFI executes none).
 */
function lockstep(p: Pair, count: number): number {
  let last = '';
  let executed = 0;
  for (let i = 0; i < count; i++) {
    const before = p.fast.rp.core.cycles;
    const pc = p.stock.rp.core.PC;
    const a = p.stock.stepCore0();
    const b = p.fast.stepCore0();
    if (a.reason !== b.reason || !same(p.stock, p.fast)) {
      throw new Error(`step ${i} (pc 0x${pc.toString(16)}, after ${last}): ${a.reason} vs ${b.reason}\n stock ${state(p.stock)}\n fast  ${state(p.fast)}`);
    }
    if (a.reason !== 'target') break;
    if (p.fast.rp.core.cycles !== before) executed++;
    last = `0x${pc.toString(16)}`;
  }
  return executed;
}

/**
 * Firmware that launches core 1 is left out: once core 1 runs, SEV wakes the other core's WFE
 * (BT80), which rp2040js's core — the reference here — doesn't do (its SEV only logs).
 */
const DUAL_CORE = new Set(['multicore.uf2']);
const PICO_FIRMWARE = readdirSync(join(REPO_ROOT, 'fixtures/firmware/pico')).filter((f) => f.endsWith('.uf2') && !DUAL_CORE.has(f));

describe('FastM0Core decode table', () => {
  it('classifies every halfword as rp2040js\'s if-chain does', () => {
    expect(OP_OF[0x4140]).toBe(OP.ADCS); // adcs r0, r0
    expect(OP_OF[0xb500]).toBe(OP.PUSH);
    expect(OP_OF[0xbd00]).toBe(OP.POP);
    expect(OP_OF[0xdf00]).toBe(OP.SVC); // a condition code of 0b1111 isn't a branch
    expect(OP_OF[0xde00]).toBe(OP.UDF);
    expect(OP_OF[0xd0fe]).toBe(OP.B_COND);
    expect(OP_OF[0xf000]).toBe(OP.WIDE);
    expect(OP_OF[0xe800]).toBe(OP.WIDE);
    expect(OP_OF[0xe7fe]).toBe(OP.B);
    expect(OP_OF[0xb672]).toBe(OP.CPSID);
    expect(OP_OF[0x4778]).toBe(OP.BX); // bx pc
    expect(OP_OF[0x4779]).toBe(OP.UNKNOWN); // bx with nonzero low bits: rp2040js doesn't decode it
    expect(classify(0x0000)).toBe(OP.LSLS_IMM); // movs r0, r0
  });
});

describe('FastM0Core in lockstep with rp2040js\'s core (BT75)', () => {
  for (const file of PICO_FIRMWARE) {
    it(`pico/${file}: 400,000 instructions`, () => {
      const p = pair((mcu) => mcu.load({ format: 'uf2', bytes: readFixture(`fixtures/firmware/pico/${file}`) }));
      expect(lockstep(p, 400_000)).toBeGreaterThan(100_000);
    }, 120_000);
  }

  it('MicroPython: boot, the raw-REPL install and main.py (1,500,000 instructions)', () => {
    const p = pair((mcu) => mcu.load(micropythonFixture('blink')), { micropython: cachedMicroPython() });
    expect(lockstep(p, 1_500_000)).toBeGreaterThan(1_000_000);
    expect(p.fast.rp.core.cycles).toBe(p.stock.rp.core.cycles);
  }, 240_000);
});

describe('FastM0Core against rp2040js\'s core on random instructions (BT75)', () => {
  // A seeded fuzz: random 16-bit instructions (all but WIDE, BKPT/UDF — our bootrom's ROM-call
  // traps — and WFI/WFE, which only wait) from random registers and flags, one at a time, from the
  // same state on both cores; memory instructions get their registers inside an SRAM scratch
  // window so stores land where the comparison looks.
  it('20,000 random instructions: the same registers, flags, cycles and scratch memory', () => {
    const p = pair((mcu) => mcu.load({ format: 'uf2', bytes: readFixture('fixtures/firmware/pico/blink.uf2') }));
    for (let i = 0; i < 20_000 && p.stock.rp.core.cycles < 2_000_000; i++) p.stock.stepCore0(), p.fast.stepCore0(); // past boot
    let seed = 0x1234567;
    const random = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const AT = 0x20030000;
    const SCRATCH = 0x20031000;
    const MEMORY = new Set<number>([OP.LDMIA, OP.LDR_IMM, OP.LDR_SP, OP.LDR_REG, OP.LDRB_IMM, OP.LDRB_REG, OP.LDRH_IMM, OP.LDRH_REG, OP.LDRSB, OP.LDRSH, OP.POP, OP.PUSH, OP.STMIA, OP.STR_IMM, OP.STR_SP, OP.STR_REG, OP.STRB_IMM, OP.STRB_REG, OP.STRH_IMM, OP.STRH_REG]);
    const SKIP = new Set<number>([OP.WIDE, OP.BKPT, OP.UDF, OP.WFI, OP.WFE]);
    let tried = 0;
    for (let n = 0; tried < 20_000 && n < 200_000; n++) {
      const opcode = random() & 0xffff;
      const op = OP_OF[opcode];
      if (SKIP.has(op)) continue;
      tried++;
      const memory = MEMORY.has(op);
      const regs = Array.from({ length: 13 }, () => (memory ? SCRATCH + (random() & 0x7fc) + ((random() & 3) === 0 ? random() & 3 : 0) : random()));
      const flags = random() & 0xf;
      for (const mcu of [p.stock, p.fast]) {
        const core = mcu.rp.core;
        mcu.rp.sram.fill(0x5a, SCRATCH - 0x20000000, SCRATCH - 0x20000000 + 0x1000);
        mcu.rp.sramView.setUint16(AT - 0x20000000, opcode, true);
        mcu.rp.sramView.setUint16(AT + 2 - 0x20000000, 0xbf00, true); // nop after it
        for (let r = 0; r < 13; r++) core.registers[r] = regs[r];
        core.registers[13] = SCRATCH + 0x800; // SP inside the window (PUSH/POP, SP-relative)
        core.registers[14] = 0x20030101;
        core.PC = AT;
        core.N = !!(flags & 8);
        core.Z = !!(flags & 4);
        core.C = !!(flags & 2);
        core.V = !!(flags & 1);
        core.executeInstruction();
      }
      const a = p.stock.rp.sram.subarray(SCRATCH - 0x20000000, SCRATCH - 0x20000000 + 0x1000);
      const b = p.fast.rp.sram.subarray(SCRATCH - 0x20000000, SCRATCH - 0x20000000 + 0x1000);
      if (!same(p.stock, p.fast) || !a.every((v, i) => v === b[i])) {
        throw new Error(`opcode 0x${opcode.toString(16)} (op ${op}) regs ${regs.map((v) => v.toString(16)).join(',')} flags ${flags}\n stock ${state(p.stock)}\n fast  ${state(p.fast)}`);
      }
    }
    expect(tried).toBe(20_000);
  }, 120_000);
});
