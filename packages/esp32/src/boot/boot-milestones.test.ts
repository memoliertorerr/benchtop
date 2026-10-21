import { beforeAll, describe, expect, it } from 'vitest';
import { BOOT_MILESTONES, bootFixture, runUntil } from '../test-support/boot.test-helper.ts';
import type { SocTracer } from '../debug/trace.ts';
import type { EspSymbols } from '../debug/symbols.ts';
import type { Esp32Soc } from '../soc/soc.ts';
import { EXCCAUSE } from '../xtensa/exceptions.ts';

// BT32: the boot passes its milestones in order — call_start_cpu0 on the PRO_CPU,
// call_start_cpu1 on the APP_CPU, esp_clk_init, app_main, initArduino, setup() (on the APP_CPU:
// CONFIG_ARDUINO_RUNNING_CORE=1) — with addresses from serial-hello.syms.tsv, and the exception
// log holds nothing but window exceptions, coprocessor-disabled traps and interrupts.

let soc: Esp32Soc;
let tracer: SocTracer;
let symbols: EspSymbols;

beforeAll(() => {
  const booted = bootFixture('serial-hello', { trace: true });
  soc = booted.soc;
  symbols = booted.symbols;
  if (booted.tracer === null) throw new Error('no tracer');
  tracer = booted.tracer;
  runUntil(soc, 0.1, () => tracer.reachedMilestone('_Z5setupv'));
}, 60_000);

describe('serial-hello boot milestones', () => {
  it('reaches every milestone, in order, on the right core', () => {
    expect(soc.stopReason).toBe('');
    expect(tracer.milestones.map((m) => `${m.cpu === 0 ? 'PRO' : 'APP'} ${m.name}`)).toEqual([
      'PRO call_start_cpu0',
      'APP call_start_cpu1',
      'PRO esp_clk_init',
      'PRO app_main',
      'PRO initArduino',
      'APP _Z5setupv',
    ]);
    expect(BOOT_MILESTONES.every((name) => symbols.address(name) !== undefined)).toBe(true);
    const times = tracer.milestones.map((m) => m.seconds);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('logs only interrupts, window (alloca) and coprocessor-disabled exceptions', () => {
    const unexpected = tracer.exceptions.filter((e) => {
      if (e.cause < 0) return e.cause === -6; // interrupts above level 1 are fine; a debug exception is not
      if (e.cause === EXCCAUSE.ALLOCA) return false;
      return !(e.cause >= EXCCAUSE.COPROCESSOR_DISABLED && e.cause < EXCCAUSE.COPROCESSOR_DISABLED + 8);
    });
    expect(unexpected.map((e) => `${e.cpu} cause ${e.cause} at ${symbols.symbolize(e.pc)}`)).toEqual([]);
  });
});
