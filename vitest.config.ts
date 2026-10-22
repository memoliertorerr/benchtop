import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Files with wall-clock budgets or speed comparisons: they run after every other test file, one
 * at a time, so nothing else competes for the CPU (under a full parallel run they flaked).
 */
const QUIET = [
  'apps/web/src/sim/perf.test.ts', // BT40 perf budget
  'packages/avr/src/debug.test.ts', // simulated MHz with and without breakpoints
  'packages/parts/src/integration/logic-analyzer.test.ts', // simulated MHz with and without probes
  'packages/esp32/src/soc/soc.test.ts', // the SoC bus within 15 % of the bare machine
  'packages/esp32/src/boot/blink.test.ts', // skip-ahead speedup ≥ 1.5×
  'packages/core/src/env/runtime-perf.test.ts', // BT54 the environment's cost per simulated second
  'packages/pcb/src/drc-perf.test.ts', // BT57 DRC on a dense board
  'apps/web/src/ui/plotter/parse.test.ts', // BT44 1,000 plotter lines in under 2 ms
  'packages/rp2040/src/perf.test.ts', // BT76 the Pico's busy loop: fast core vs rp2040js's
];

export default defineConfig({
  test: {
    environment: 'node',
    // Emulator tests run real CPU loops; keep them honest about runaway programs. 30 s: a 2 s
    // blink that takes ~2 s alone has taken 11 s under the full parallel run (8 cores, BT47).
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'tests',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...QUIET],
        },
      },
      { extends: true, test: { name: 'quiet', include: QUIET, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ],
  },
});
