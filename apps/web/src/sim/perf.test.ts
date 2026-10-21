/**
 * The perf budget (BT40): the worker's whole pipeline — bench, analog layer, frame collection,
 * frame ring — keeps up with real time on a busy bench. fixtures/projects/perf-100-leds.json is
 * an Uno running blink with 100 red LEDs (each behind its own 220 Ω resistor) on six
 * breadboards, all on D13 — one 101-net network the analog layer solves on every edge; the
 * session runs it at speed Max on the real clock for 2 s of simulated time.
 *
 * Measured in a spawned plain `node` (perf.test-helper.ts says why), like apps/cli's spawn test.
 * The budget is on CPU time — simulated time per second of the core the run used — because a
 * full `npm run verify` keeps every core busy with other emulator tests, while the browser's
 * worker gets a core of its own; wall time is reported beside it (≈ the same on an idle machine).
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PerfReport {
  simulatedMs: number;
  wallMs: number;
  cpuMs: number;
  ratio: number;
  cpuRatio: number;
  leds: number;
  minFlips: number;
  ring: boolean;
  problems: string[];
}

function measure(): PerfReport {
  const helper = fileURLToPath(new URL('./perf.test-helper.ts', import.meta.url));
  const out = execFileSync(process.execPath, [helper, 'perf-100-leds', '2000'], { encoding: 'utf8', timeout: 30_000 });
  return JSON.parse(out) as PerfReport;
}

describe('perf budget', () => {
  it('Uno blink + 100 LEDs on breadboards runs at ≥ 100 % real time at speed Max', () => {
    let report = measure();
    // One retry: contention also slows a core's own work (shared caches, clocks).
    if (report.cpuRatio < 1) report = measure();
    console.log(
      `perf budget: ${report.simulatedMs.toFixed(0)} ms simulated in ${report.cpuMs.toFixed(0)} ms CPU (${(report.cpuRatio * 100).toFixed(0)} % real time), ` +
        `${report.wallMs.toFixed(0)} ms wall (${(report.ratio * 100).toFixed(0)} %)`,
    );
    expect(report.leds).toBe(100);
    expect(report.ring).toBe(true);
    expect(report.simulatedMs).toBeGreaterThanOrEqual(2000);
    // Every LED blinked with D13 (on, off, on, off … every 500 ms).
    expect(report.minFlips).toBeGreaterThanOrEqual(3);
    expect(report.cpuRatio).toBeGreaterThanOrEqual(1);
  }, 70_000);
});
