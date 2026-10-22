import { describe, expect, it } from 'vitest';
import { createRp2040Mcu, RP2040_CLOCK_HZ } from './rp2040-mcu.ts';
import { picoFirmware, runMs } from './rp2040.test-helper.ts';

// BT76: the Pico's speed on a busy loop — float-math's loop() is empty, so arduino-pico's main
// loop spins with nothing to wait for and every simulated cycle is an instruction. The fast core,
// batched, against rp2040js's own core one instruction at a time (BT75's baseline), on the same
// machine at the same moment. In QUIET (vitest.config.ts): it compares wall-clock speed.

/** Simulated clk_sys cycles (200 MHz here) per wall second, after 300 ms of boot. */
function mhz(core: 'fast' | 'stock', ms: number): number {
  const mcu = createRp2040Mcu({ core });
  mcu.load({ format: 'uf2', bytes: picoFirmware('float-math') });
  runMs(mcu, 300);
  const cycles = mcu.rp.core.cycles;
  const start = performance.now();
  runMs(mcu, ms);
  const seconds = (performance.now() - start) / 1000;
  expect(mcu.cycles).toBeGreaterThanOrEqual(((300 + ms) * RP2040_CLOCK_HZ) / 1000);
  return (mcu.rp.core.cycles - cycles) / seconds / 1e6;
}

describe('RP2040 busy-loop speed (BT76)', () => {
  it('the fast core, batched, is ≥ 2.5× rp2040js\'s core and ≥ 60 simulated MHz', () => {
    const stock = mhz('stock', 200);
    const fast = mhz('fast', 500);
    console.info(`rp2040 busy loop: fast ${fast.toFixed(0)} MHz, stock ${stock.toFixed(0)} MHz of a 200 MHz clk_sys per wall second (${(fast / stock).toFixed(1)}×)`);
    expect(fast / stock).toBeGreaterThanOrEqual(2.5);
    expect(fast).toBeGreaterThanOrEqual(60);
  }, 60_000);
});
