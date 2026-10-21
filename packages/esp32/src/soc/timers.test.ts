import { describe, expect, it } from 'vitest';
import { createTestSoc } from '../test-support/soc.test-helper.ts';
import { REF_HZ } from './context.ts';
import { CODE_REBOOT, type Esp32Soc } from './soc.ts';

// BT33: TIMG timers and LACT, the MWDT and RTC watchdogs, software resets, CPU stall, the reboot
// loop guard and WAITI skip-ahead, on the SoC with small programs (no firmware).

const TG0 = 0x3ff5f000;
const TG1 = 0x3ff60000;
const RTC = 0x3ff48000;
const EN = 1 << 31;
const INCREASE = 1 << 30;
const AUTORELOAD = 1 << 29;
const LEVEL_INT_EN = 1 << 11;
const ALARM_EN = 1 << 10;
const KEY = 0x50d83aa1;
const US = REF_HZ / 1e6; // reference cycles per µs
const MS = REF_HZ / 1e3;

/**
 * A SoC at XTAL 40 MHz (APB 40 MHz) whose PRO_CPU either spins in bench-loop (0.5 s of work) or
 * sleeps in `waiti 0` with nothing enabled, so time can pass. A reboot restarts the program (RAM
 * keeps it).
 */
function spinning(program: 'bench-loop' | 'sleep' = 'sleep'): Esp32Soc {
  const soc = program === 'sleep' ? createTestSoc() : createTestSoc({ program });
  if (program === 'sleep') soc.memory.load(0x40080000, Uint8Array.of(0x00, 0x70, 0x00)); // waiti 0
  soc.cores[0].pc = 0x40080000;
  soc.bootLoader = (reason) => {
    soc.rtc.setResetCause(reason);
    soc.cores[0].pc = 0x40080000;
  };
  return soc;
}

const w = (soc: Esp32Soc, address: number, value: number): void => soc.buses[0].write32(address, value);
const r = (soc: Esp32Soc, address: number): number => soc.buses[0].read32(address) >>> 0;
/** TIMG counter c (0 T0, 1 T1, 2 LACT) latched and read: UPDATE, then HI:LO. */
function counter(soc: Esp32Soc, tg: number, c: number): number {
  const base = tg + [0x00, 0x24, 0x74][c];
  w(soc, base + 0x0c, 1);
  return r(soc, base + 0x08) * 2 ** 32 + r(soc, base + 0x04);
}

describe('TIMG timers (BT33)', () => {
  it('counts APB / divider and fires an auto-reloading alarm at the exact tick', () => {
    const soc = spinning();
    w(soc, TG0 + 0x98, 1); // INT_ENA T0
    w(soc, TG0 + 0x10, 1000); // ALARMLO: 1000 ticks
    w(soc, TG0 + 0x14, 0);
    w(soc, TG0 + 0x00, EN | INCREASE | AUTORELOAD | (40 << 13) | LEVEL_INT_EN | ALARM_EN); // 40 MHz / 40: 1 tick per µs
    soc.runUntil(999 * US);
    expect(counter(soc, TG0, 0)).toBe(999);
    expect(r(soc, TG0 + 0x9c) & 1).toBe(0);
    soc.runUntil(1000 * US);
    expect(r(soc, TG0 + 0x9c) & 1).toBe(1); // INT_RAW T0
    expect(r(soc, TG0 + 0xa0) & 1).toBe(1); // INT_ST
    expect(soc.matrix.lines[14]).toBe(1); // ETS_TG0_T0_LEVEL_INTR_SOURCE
    expect(r(soc, TG0 + 0x00) & ALARM_EN).toBe(0); // cleared by the alarm
    soc.runUntil(1010 * US);
    expect(counter(soc, TG0, 0)).toBe(10); // reloaded to 0 at the alarm
    w(soc, TG0 + 0xa4, 1); // INT_CLR
    expect(soc.matrix.lines[14]).toBe(0);
  });

  it('counts down to an alarm, and LACT runs as esp_timer drives it', () => {
    const soc = spinning();
    w(soc, TG1 + 0x24 + 0x18, 5000); // T1 LOADLO
    w(soc, TG1 + 0x24 + 0x1c, 0);
    w(soc, TG1 + 0x24 + 0x20, 1); // T1 LOAD
    w(soc, TG1 + 0x24 + 0x10, 3000); // ALARMLO
    w(soc, TG1 + 0x24 + 0x14, 0);
    w(soc, TG1 + 0x24, EN | (40 << 13) | LEVEL_INT_EN | ALARM_EN); // decrement, 1 MHz
    // LACT: divider 20 → 2 MHz (esp_timer's TICKS_PER_US = 2 at 40 MHz), alarm at 4000 ticks.
    w(soc, TG1 + 0x84, 4000);
    w(soc, TG1 + 0x88, 0);
    w(soc, TG1 + 0x70, EN | INCREASE | (20 << 13) | LEVEL_INT_EN | ALARM_EN);
    soc.runUntil(1999 * US);
    expect(r(soc, TG1 + 0x9c) & 0b1010).toBe(0);
    soc.runUntil(2000 * US);
    expect(r(soc, TG1 + 0x9c) & 0b1010).toBe(0b1010); // T1 (bit 1) and LACT (bit 3)
    expect([soc.matrix.lines[19], soc.matrix.lines[21]]).toEqual([1, 1]);
    expect(counter(soc, TG1, 1)).toBe(3000);
    expect(counter(soc, TG1, 2)).toBe(4000);
  });

  it('keeps counting at the right rate across an APB clock change', () => {
    const soc = spinning();
    w(soc, TG0 + 0x00, EN | INCREASE | (40 << 13)); // 1 MHz at APB 40 MHz
    soc.runUntil(100 * US);
    w(soc, 0x3ff66000, 1); // SYSCON PRE_DIV_CNT: XTAL / 2 → APB 20 MHz, 0.5 MHz
    expect(soc.apbHz).toBe(20e6);
    soc.runUntil(300 * US);
    expect(counter(soc, TG0, 0)).toBe(100 + 100);
  });
});

describe('watchdogs (BT33)', () => {
  it('MWDT: write protection, an interrupt stage, feeding, then a system reset that reboots', () => {
    const soc = spinning();
    w(soc, TG1 + 0x64, 0); // lock
    w(soc, TG1 + 0x48, EN);
    expect(r(soc, TG1 + 0x48) & EN).toBe(0); // ignored while locked
    w(soc, TG1 + 0x64, KEY);
    w(soc, TG1 + 0x4c, 40000 << 16); // prescaler: 1 ms ticks at 40 MHz
    w(soc, TG1 + 0x50, 300); // stage 0: 300 ms
    w(soc, TG1 + 0x54, 600); // stage 1: 600 ms
    w(soc, TG1 + 0x48, EN | (1 << 29) | (3 << 27) | (1 << 21)); // STG0 interrupt, STG1 reset system, LEVEL_INT_EN
    soc.runUntil(299 * MS);
    expect(soc.matrix.lines[20]).toBe(0);
    soc.runUntil(300 * MS);
    expect(r(soc, TG1 + 0x9c) & 4).toBe(4);
    expect(soc.matrix.lines[20]).toBe(1); // ETS_TG1_WDT_LEVEL_INTR_SOURCE
    w(soc, TG1 + 0xa4, 4);
    w(soc, TG1 + 0x60, 1); // feed: back to stage 0
    soc.runUntil(599 * MS);
    expect(r(soc, TG1 + 0x9c) & 4).toBe(0);
    soc.runUntil(600 * MS);
    expect(r(soc, TG1 + 0x9c) & 4).toBe(4);
    soc.runUntil(1199 * MS);
    expect(soc.boots).toBe(0);
    soc.runUntil(1201 * MS); // stage 1 at 1200 ms, then RESET_SETTLE (100 µs)
    expect(soc.boots).toBe(1);
    expect(r(soc, RTC + 0x34) & 0x3f).toBe(8); // TG1WDT_SYS_RESET
    expect(soc.problems.problems.find((p) => p.code === CODE_REBOOT)?.message).toMatch(/^reboot after TG1WDT_SYS_RESET \(0x08\) at 1\.2001/);
    expect(r(soc, TG1 + 0x48) & EN).toBe(0); // the reset turned it off
  });

  it('RTC WDT: an RTC reset clears the STORE registers and RTC memory, a system reset keeps them', () => {
    for (const [action, kept] of [
      [3, true],
      [4, false],
    ] as const) {
      const soc = spinning();
      w(soc, RTC + 0xb8, 0x1234); // STORE6
      w(soc, 0x50000000, 0xcafe); // RTC SLOW memory
      w(soc, RTC + 0x90, 150); // stage 0: 150 slow ticks = 1 ms
      w(soc, RTC + 0x8c, EN | (action << 28));
      soc.runUntil(2 * MS);
      expect(soc.boots).toBe(1);
      expect(r(soc, RTC + 0x34) & 0x3f).toBe(action === 3 ? 9 : 16);
      expect([r(soc, RTC + 0xb8), r(soc, 0x50000000)]).toEqual(kept ? [0x1234, 0xcafe] : [0, 0]);
    }
  });
});

describe('software resets, stall and the reboot loop guard (BT33)', () => {
  it('SW_SYS_RST holds both CPUs and reboots after 100 µs with SW_RESET', () => {
    const soc = spinning('bench-loop');
    soc.runUntil(10 * US);
    w(soc, RTC, r(soc, RTC) | (1 << 31));
    expect(r(soc, RTC) >>> 31).toBe(0); // self-clearing
    const before = soc.cores[0].instructions;
    soc.runUntil(110 * US - 1);
    expect(soc.cores[0].instructions).toBe(before);
    expect(soc.boots).toBe(0);
    soc.runUntil(111 * US);
    expect(soc.boots).toBe(1);
    expect(r(soc, RTC + 0x34) & 0xfff).toBe(3 | (3 << 6));
    expect(soc.cores[0].instructions).toBeGreaterThan(before);
  });

  it('SW_PROCPU_RST waits while the PRO_CPU is stalled, and reboots with SW_CPU_RESET once released', () => {
    const soc = spinning('bench-loop');
    w(soc, RTC + 0xac, 0x21 << 26); // SW_STALL_PROCPU_C1
    w(soc, RTC, (r(soc, RTC) & ~0xc) | (2 << 2)); // SW_STALL_PROCPU_C0 → stalled
    const before = soc.cores[0].instructions;
    w(soc, RTC, r(soc, RTC) | (1 << 5)); // SW_PROCPU_RST
    soc.runUntil(1 * MS);
    expect([soc.boots, soc.cores[0].instructions]).toEqual([0, before]);
    w(soc, RTC, r(soc, RTC) & ~0xc); // unstall
    soc.runUntil(1 * MS + 100 * US);
    expect(soc.boots).toBe(1);
    expect(r(soc, RTC + 0x34) & 0x3f).toBe(12);
  });

  it('stops the run after 5 rapid reboots in a row', () => {
    const soc = spinning();
    soc.bootLoader = (reason) => {
      soc.rtc.setResetCause(reason);
      soc.cores[0].pc = 0x40080000;
      w(soc, RTC, r(soc, RTC) | (1 << 31)); // and straight into the next reset
    };
    w(soc, RTC, r(soc, RTC) | (1 << 31));
    const result = soc.runUntil(10 * MS);
    expect(result).toEqual({ reason: 'fault', detail: 'reboot loop: SW_RESET (0x03) after 5 reboots in a row less than 1 s apart' });
    expect(soc.boots).toBe(5);
    expect(soc.problems.problems.filter((p) => p.code === CODE_REBOOT)).toHaveLength(5);
  });
});

describe('WAITI skip-ahead (BT33)', () => {
  it('jumps straight to the target while both CPUs sleep, with the same state as running every slice', () => {
    const results = [true, false].map((skipIdle) => {
      const soc = createTestSoc();
      soc.memory.load(0x40080000, Uint8Array.of(0x00, 0x70, 0x00)); // waiti 0 (nothing enabled: sleeps for good)
      soc.cores[0].pc = 0x40080000;
      soc.skipIdle = skipIdle;
      const started = performance.now();
      soc.runUntil(REF_HZ); // 1 s
      return { soc, wall: performance.now() - started };
    });
    const [on, off] = results;
    expect(on.soc.skipped).toBeGreaterThan(0.999 * REF_HZ);
    expect(off.soc.skipped).toBe(0);
    for (const { soc } of results) {
      expect(soc.cores[0].instructions).toBe(1);
      expect(soc.cores[0].ccount).toBe(40e6); // 1 s at XTAL 40 MHz
    }
    expect(on.soc.cores[0].cycles).toBe(off.soc.cores[0].cycles);
    expect(on.wall).toBeLessThan(off.wall);
  });
});
