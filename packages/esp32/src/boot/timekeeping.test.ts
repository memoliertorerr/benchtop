import { beforeAll, describe, expect, it } from 'vitest';
import { REF_HZ } from '../soc/context.ts';
import type { Esp32Soc } from '../soc/soc.ts';
import { bootFixture, runUntil } from '../test-support/boot.test-helper.ts';

// BT33: the timekeeping fixture — vTaskDelay lines every 250 ms with millis(), micros() and a
// 100 ms hardware-timer ISR count; the CPU drops from 240 to 80 MHz after the 8th line. The
// FreeRTOS tick (CCOMPARE0 on each core) must stay 1 ms in reference time at every CPU clock.

interface Line {
  text: string;
  /** Reference time the line's first byte finished. */
  time: number;
}

let soc: Esp32Soc;
const lines: Line[] = [];
/** PRO_CPU tick-handler entries: [reference time, CPU Hz]. */
const ticks: [number, number][] = [];

beforeAll(() => {
  const booted = bootFixture('timekeeping');
  soc = booted.soc;
  let text = '';
  let first = -1;
  soc.onUart = (port, byte) => {
    if (port !== 0) return;
    if (first < 0) first = soc.now();
    if (byte === 0x0a) {
      lines.push({ text: text.replace(/\r$/, ''), time: first });
      text = '';
      first = -1;
    } else text += String.fromCharCode(byte);
  };
  const handler = booted.symbols.address('xPortSysTickHandler');
  if (handler === undefined) throw new Error('xPortSysTickHandler not in timekeeping.syms.tsv');
  const pro = soc.cores[0];
  pro.instructionHook = (pc) => {
    if (pc === handler) ticks.push([soc.now(), soc.cpuHz]);
  };
  runUntil(soc, 4.5);
}, 120_000);

const parse = (line: Line): { t: number; us: number; isr: number } | null => {
  const m = /^t=(\d+) us=(\d+) isr=(\d+)$/.exec(line.text);
  return m === null ? null : { t: Number(m[1]), us: Number(m[2]), isr: Number(m[3]) };
};

describe('timekeeping (BT33)', () => {
  it('prints a line every 250 ms; millis() advances 250 ±1 per line', () => {
    expect(soc.stopReason).toBe('');
    expect(lines[0].text).toMatch(/^start us=\d+$/);
    const cut = lines.findIndex((l) => l.text === 'cpu=80');
    expect(cut).toBeGreaterThan(0);
    const steps: number[] = [];
    for (const segment of [lines.slice(0, cut), lines.slice(cut + 1)]) {
      const data = segment.map(parse).filter((d) => d !== null);
      expect(data.length).toBeGreaterThanOrEqual(7);
      for (let i = 1; i < data.length; i++) steps.push(data[i]!.t - data[i - 1]!.t);
    }
    for (const step of steps) expect(Math.abs(step - 250)).toBeLessThanOrEqual(1);
    // Across the clock change setCpuFrequencyMhz runs the UART's APB-change callback, which waits
    // for the TX FIFO to drain — the previous ~30-byte line, ≈ 2.6 ms at 115200 baud.
    const before = parse(lines[cut - 1])!;
    const after = parse(lines[cut + 1])!;
    expect(after.t - before.t).toBeGreaterThanOrEqual(250);
    expect(after.t - before.t).toBeLessThanOrEqual(254);
  });

  it('micros() tracks simulated time within ±0.1 %', () => {
    const data = lines.filter((l) => parse(l) !== null);
    const a = data[0];
    for (const b of data.slice(1)) {
      const us = parse(b)!.us - parse(a)!.us;
      const sim = ((b.time - a.time) / REF_HZ) * 1e6;
      expect(Math.abs(us - sim)).toBeLessThanOrEqual(sim * 0.001);
    }
  });

  it('counts exactly 10 timer ISRs per second (100 ms auto-reload alarm), before and after the clock change', () => {
    const data = lines.map(parse);
    const cut = lines.findIndex((l) => l.text === 'cpu=80');
    const before = data.slice(0, cut).filter((d) => d !== null);
    const after = data.slice(cut + 1).filter((d) => d !== null);
    // Lines four apart are 1 s apart in ticks: exactly ten alarms between them.
    for (const segment of [before, after]) {
      expect(segment.length).toBeGreaterThanOrEqual(5);
      for (let i = 4; i < segment.length; i++) expect(segment[i]!.isr - segment[i - 4]!.isr).toBe(10);
    }
  });

  it('keeps the FreeRTOS tick at 1 ms ±1 % in reference time at 240 MHz and at 80 MHz', () => {
    const report: string[] = [];
    for (const hz of [160e6, 240e6, 80e6]) {
      const intervals: number[] = [];
      for (let i = 1; i < ticks.length; i++) if (ticks[i][1] === hz && ticks[i - 1][1] === hz) intervals.push((ticks[i][0] - ticks[i - 1][0]) / REF_HZ);
      if (intervals.length === 0) {
        report.push(`${hz / 1e6} MHz: no tick pair`);
        continue;
      }
      const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
      const within = intervals.filter((s) => Math.abs(s - 0.001) <= 0.00001).length;
      report.push(`${hz / 1e6} MHz: ${intervals.length} periods, mean ${(mean * 1e3).toFixed(6)} ms, ${within} within ±1 %`);
      if (hz !== 160e6) {
        expect(intervals.length).toBeGreaterThanOrEqual(100);
        expect(Math.abs(mean - 0.001)).toBeLessThanOrEqual(0.00001);
        expect(within / intervals.length).toBeGreaterThanOrEqual(0.95);
      }
    }
    console.info(`FreeRTOS tick (PRO_CPU): ${report.join('; ')}`);
  });
});
