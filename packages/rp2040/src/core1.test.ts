import { parseElf32, SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../core/src/firmware/fixtures.test-helper.ts';
import { createRp2040Mcu, RP2040_CLOCK_HZ, type Rp2040Mcu } from './rp2040-mcu.ts';
import { runMs } from './rp2040.test-helper.ts';

// BT80: both cores, from fixtures/rp2040/core1.c — a freestanding program that resets core 1,
// launches it through the bootrom's FIFO protocol and checks the per-core hardware phase by
// phase (the RESULTS layout is in the program's header).

const RESULTS = 0x20030000;

function results(core: 'fast' | 'stock' = 'fast'): number[] {
  const mcu = createRp2040Mcu({ core });
  mcu.load({ format: 'elf', bytes: readFixture('fixtures/rp2040/core1.elf') });
  runMs(mcu, 60);
  return Array.from({ length: 17 }, (_, i) => mcu.rp.readUint32(RESULTS + 4 * i) >>> 0);
}

describe('RP2040 core 1 (BT80)', () => {
  const r = results();

  it('runs to the end', () => {
    expect(r[16]).toBe(0xd0e);
  });

  it('CPUID is 0 on core 0 and 1 on core 1; the FIFOs carry words both ways', () => {
    expect(r[0]).toBe(0);
    expect(r[1]).toBe(1);
    expect(r.slice(2, 6)).toEqual([11, 21, 31, 41]);
  });

  it('each core has its own SysTick, counting at its own reload', () => {
    // 10 ms: core 0 every 100 µs, core 1 every 200 µs
    expect(Math.abs(r[6] - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(r[7] - 50)).toBeLessThanOrEqual(1);
  });

  it('a peripheral interrupt reaches the core whose NVIC enabled it', () => {
    expect(r[8]).toBe(1);
    expect(r[9]).toBe(0);
  });

  it('SEV on core 1 wakes core 0 from WFE', () => {
    expect(r[10]).toBe(1);
  });

  it('FIFO_ST: ROE after reading an empty FIFO, cleared by a write; WOF after a 9th word', () => {
    expect(r[11]).toBe(0b1010); // ROE | RDY
    expect(r[12]).toBe(0b0010); // RDY
    expect(r[13]).toBe(0b0100); // WOF, full (not RDY)
  });

  it('a reset through the PSM brings core 1 back to its bootrom (a 0) and a second launch runs', () => {
    expect(r[14]).toBe(0);
    expect(r[15]).toBe(0x22);
  });
});

describe('two cores in the run loop (BT81)', () => {
  const core1Time = (mcu: Rp2040Mcu): number => (mcu as unknown as { core1Nanos: number }).core1Nanos;
  const time = (mcu: Rp2040Mcu): number => mcu.rp.clock.nanos;

  it('core 1 keeps within one 5 µs slice of core 0', () => {
    const mcu = createRp2040Mcu();
    mcu.load({ format: 'elf', bytes: readFixture('fixtures/rp2040/core1.elf') });
    let worst = 0;
    let launched = 0;
    for (let i = 0; i < 600; i++) {
      mcu.runUntil(mcu.cycles + RP2040_CLOCK_HZ / 10_000); // 100 µs
      if (!mcu.dual.launched) continue;
      launched++;
      worst = Math.max(worst, time(mcu) - core1Time(mcu));
      expect(core1Time(mcu)).toBeLessThanOrEqual(time(mcu));
    }
    expect(launched).toBeGreaterThan(100);
    expect(worst).toBeLessThanOrEqual(5_000);
  });

  it('a breakpoint on core 0 stops the chip with core 1 in time; the program still ends right', () => {
    const elf = readFixture('fixtures/rp2040/core1.elf');
    const isr = SymbolTable.fromElf(parseElf32(elf)).lookup('isr_systick0')?.address as number;
    const mcu = createRp2040Mcu();
    mcu.load({ format: 'elf', bytes: elf });
    const debug = mcu.debug();
    debug.setBreakpoint(isr);
    let stop = mcu.runUntil(RP2040_CLOCK_HZ / 20); // 50 ms
    expect(stop.reason).toBe('breakpoint');
    expect(mcu.dual.launched).toBe(true);
    expect(time(mcu) - core1Time(mcu)).toBeLessThanOrEqual(5_000);
    for (let i = 0; i < 20; i++) debug.step();
    expect(time(mcu) - core1Time(mcu)).toBeLessThanOrEqual(5_000);
    debug.clearBreakpoint(isr);
    stop = mcu.runUntil(RP2040_CLOCK_HZ / 10);
    expect(stop.reason).toBe('target');
    expect(mcu.rp.readUint32(RESULTS + 4 * 16) >>> 0).toBe(0xd0e);
    expect(mcu.rp.readUint32(RESULTS + 4 * 7) >>> 0).toBeGreaterThan(40); // core 1's SysTick ran
  });
});
