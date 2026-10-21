import { describe, expect, it } from 'vitest';
import { BareMachine } from '../test-support/bare-machine.test-helper.ts';
import { HALT } from './cpu.ts';

describe('bench-loop', () => {
  it('runs 10 million iterations and reports simulated MIPS', () => {
    const machine = BareMachine.load('bench-loop');
    const start = performance.now();
    const core = machine.run(30_000_000);
    const seconds = (performance.now() - start) / 1000;
    expect(core.halt).toBe(HALT.BREAK);
    expect(machine.a(2)).toBe(10_000_000);
    const mips = core.instructions / seconds / 1e6;
    console.info(`bench-loop: ${core.instructions.toLocaleString('en-US')} instructions in ${seconds.toFixed(2)} s = ${mips.toFixed(1)} simulated MIPS`);
    expect(core.instructions).toBeGreaterThan(20_000_000);
  }, 60_000);
});
