import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildUf2, UF2_FAMILY } from '@benchtop/core';
import { readFixture, REPO_ROOT } from '../../core/src/firmware/fixtures.test-helper.ts';
import type { FastCore } from './m0/fast-core.ts';
import { cachedMicroPython, micropythonFixture } from './micropython.test-helper.ts';
import { createRp2040Mcu, type Rp2040Mcu } from './rp2040-mcu.ts';

// BT76: batched runs — many instructions per call, the clock following the core's cycles — give
// exactly what one instruction at a time gives. A breakpoint anywhere makes the run loop step one
// instruction at a time (it checks the PC before each), so a breakpoint at an address no code
// reaches is the one-at-a-time reference.

const NOWHERE = 0x0ffffff0; // past the ROM, before flash: never executed

/** Reference cycles (125 MHz) for `us` microseconds. */
const US = 125;

function oneAtATime(mcu: Rp2040Mcu): Rp2040Mcu {
  mcu.debug().setBreakpoint(NOWHERE);
  return mcu;
}

/** Counts the core's runCycles calls (batches). */
function countBatches(mcu: Rp2040Mcu): { count: number } {
  const core = mcu.rp.core as FastCore;
  const run = core.runCycles.bind(core);
  const counter = { count: 0 };
  core.runCycles = (stop: number) => {
    counter.count++;
    run(stop);
  };
  return counter;
}

function state(mcu: Rp2040Mcu): string {
  const c = mcu.rp.core;
  return `cycles=${c.cycles} r=${[...c.registers].map((v) => v.toString(16)).join(',')} NZCV=${+c.N}${+c.Z}${+c.C}${+c.V} IPSR=${c.IPSR} waiting=${c.waiting}`;
}

/** Runs both chips to `us` microseconds in `step` slices; the first slice they differ after fails. */
function compare(batched: Rp2040Mcu, reference: Rp2040Mcu, us: number, step: number): void {
  for (let t = step; t <= us; t += step) {
    const a = batched.runUntil(t * US);
    const b = reference.runUntil(t * US);
    expect(a.reason).toBe('target');
    expect(b.reason).toBe('target');
    const x = state(batched);
    const y = state(reference);
    if (x !== y) throw new Error(`after ${t} µs:\n batched     ${x}\n one-at-once ${y}`);
  }
}

/**
 * Firmware that launches core 1 is left out: with two cores, a breakpoint makes core 1 catch up
 * after every core-0 instruction while a batched run interleaves 5 µs slices (BT81) — the same
 * program, but not the same interleaving (core1.test.ts checks dual-core runs).
 */
const DUAL_CORE = new Set(['multicore.uf2']);
const PICO_FIRMWARE = readdirSync(join(REPO_ROOT, 'fixtures/firmware/pico')).filter((f) => f.endsWith('.uf2') && !DUAL_CORE.has(f));

describe('batched RP2040 runs equal one instruction at a time (BT76)', () => {
  for (const file of PICO_FIRMWARE) {
    it(`pico/${file}: 250 ms, compared every 50 µs`, () => {
      const load = (mcu: Rp2040Mcu): Rp2040Mcu => {
        mcu.load({ format: 'uf2', bytes: readFixture(`fixtures/firmware/pico/${file}`) });
        return mcu;
      };
      compare(load(createRp2040Mcu()), oneAtATime(load(createRp2040Mcu())), 250_000, 50);
    }, 60_000);
  }

  it('MicroPython: boot and the raw-REPL install over USB (300 ms)', () => {
    const load = (mcu: Rp2040Mcu): Rp2040Mcu => {
      mcu.load(micropythonFixture('blink'));
      return mcu;
    };
    const micropython = cachedMicroPython();
    compare(load(createRp2040Mcu({ micropython })), oneAtATime(load(createRp2040Mcu({ micropython }))), 300_000, 50);
  }, 120_000);
});

describe('the clock inside a batch (BT76)', () => {
  // A RAM image: 2000 times, read TIMERAWL (µs) and store it — ten cycles a pass at 125 MHz.
  //   ldr r0, =0x20001000; ldr r1, =0x40054028; ldr r3, =2000
  //   loop: ldr r2, [r1]; str r2, [r0]; adds r0, #4; subs r3, #1; bne loop; b .
  const TIMER_READS = Uint16Array.of(0x4804, 0x4905, 0x4b05, 0x680a, 0x6002, 0x3004, 0x3b01, 0xd1fa, 0xe7fe, 0x0000);
  const READS_LITERALS = Uint32Array.of(0x20001000, 0x40054028, 2000);

  function ramImage(code: Uint16Array, literals: Uint32Array): Uint8Array {
    const bytes = new Uint8Array(code.length * 2 + literals.length * 4);
    const view = new DataView(bytes.buffer);
    code.forEach((h, i) => view.setUint16(i * 2, h, true));
    literals.forEach((w, i) => view.setUint32(code.length * 2 + i * 4, w, true));
    return buildUf2([{ address: 0x20000000, data: bytes }], UF2_FAMILY.RP2040);
  }

  function reads(mcu: Rp2040Mcu): number[] {
    return Array.from({ length: 2000 }, (_, i) => mcu.rp.readUint32(0x20001000 + i * 4));
  }

  it('each timer read sees its own instruction\'s time, in one batch', () => {
    const mcu = createRp2040Mcu();
    mcu.load({ format: 'uf2', bytes: ramImage(TIMER_READS, READS_LITERALS) });
    const batches = countBatches(mcu);
    expect(mcu.runUntil(200 * US).reason).toBe('target');
    expect(batches.count).toBeLessThanOrEqual(2); // no alarm: the whole run is one or two calls
    const values = reads(mcu);
    for (let i = 1; i < values.length; i++) expect(values[i] - values[i - 1]).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < values.length; i++) expect(values[i] - values[i - 1]).toBeLessThanOrEqual(1);
    // 2000 passes × 80 ns: 160 µs, a new microsecond every 12.5 reads
    expect(values[1999] - values[0]).toBeGreaterThanOrEqual(159);
    expect(values[1999] - values[0]).toBeLessThanOrEqual(160);
    expect(new Set(values).size).toBeGreaterThanOrEqual(160);
    // and exactly what one instruction at a time reads
    const reference = oneAtATime(createRp2040Mcu());
    reference.load({ format: 'uf2', bytes: ramImage(TIMER_READS, READS_LITERALS) });
    reference.runUntil(200 * US);
    expect(values).toEqual(reads(reference));
  });

  // Arms ALARM0 5 µs ahead, then polls INTR until it fires and stores the time it saw.
  //   ldr r1, =0x40054000; ldr r0, =0x20001000
  //   ldr r2, [r1, #0x28]; adds r2, #5; str r2, [r1, #0x10]; str r2, [r0]
  //   poll: ldr r3, [r1, #0x34]; lsls r3, r3, #31; beq poll
  //   ldr r2, [r1, #0x28]; str r2, [r0, #4]; b .
  const ALARM = Uint16Array.of(0x4905, 0x4806, 0x6a8a, 0x3205, 0x610a, 0x6002, 0x6b4b, 0x07db, 0xd0fc, 0x6a8a, 0x6042, 0xe7fe);
  const ALARM_LITERALS = Uint32Array.of(0x40054000, 0x20001000);

  it('an alarm the firmware arms inside a batch ends it: the alarm fires on time', () => {
    const mcu = createRp2040Mcu();
    mcu.load({ format: 'uf2', bytes: ramImage(ALARM, ALARM_LITERALS) });
    const batches = countBatches(mcu);
    expect(mcu.runUntil(200 * US).reason).toBe('target');
    const armed = mcu.rp.readUint32(0x20001000);
    const seen = mcu.rp.readUint32(0x20001004);
    expect(armed).toBeGreaterThan(0);
    // rp2040js truncates the delay to whole microseconds: it may fire up to 1 µs early
    expect(seen - armed).toBeGreaterThanOrEqual(-1);
    expect(seen - armed).toBeLessThanOrEqual(1);
    expect(batches.count).toBeGreaterThanOrEqual(2); // cut at the ALARM0 write
    const reference = oneAtATime(createRp2040Mcu());
    reference.load({ format: 'uf2', bytes: ramImage(ALARM, ALARM_LITERALS) });
    reference.runUntil(200 * US);
    expect([reference.rp.readUint32(0x20001000), reference.rp.readUint32(0x20001004)]).toEqual([armed, seen]);
    expect(reference.rp.core.cycles).toBe(mcu.rp.core.cycles);
  });
});
