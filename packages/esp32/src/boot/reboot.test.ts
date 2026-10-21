import { describe, expect, it } from 'vitest';
import { REF_HZ } from '../soc/context.ts';
import { CODE_REBOOT } from '../soc/soc.ts';
import { bootFixture, runUntil } from '../test-support/boot.test-helper.ts';

// BT33: watchdog panics and software restarts reboot the chip; a rapid reboot loop ends the run.

describe('reboots (BT33)', () => {
  it('wdt-trip: the interrupt watchdog panics, the chip reboots and setup() runs again', () => {
    const { soc, uart } = bootFixture('wdt-trip');
    // Stop at the second "start": each crash cycle is ~72 M busy-loop instructions.
    runUntil(soc, 3.5, () => uart[0].split('start\r\n').length - 1 >= 2);
    expect(soc.stopReason).toBe('');
    const out = uart[0];
    expect(out).toContain('Guru Meditation Error');
    expect(out).toContain('Interrupt wdt timeout');
    expect(out.split('start\r\n').length - 1).toBeGreaterThanOrEqual(2);
    expect(out).not.toContain('survived');
    const reboots = soc.problems.problems.filter((p) => p.code === CODE_REBOOT);
    expect(reboots.length).toBeGreaterThanOrEqual(1);
    expect(reboots[0].severity).toBe('info');
    console.info(`wdt-trip: ${soc.boots} boots by ${soc.seconds().toFixed(3)} s; ${reboots.map((p) => p.message).join('; ')}`);
  }, 60_000);

  it('restart-loop: ESP.restart() at the top of setup ends, after 5 rapid reboots, as a reboot-loop fault', () => {
    const { soc, uart } = bootFixture('restart-loop');
    const result = soc.runUntil(10 * REF_HZ);
    expect(result.reason).toBe('fault');
    expect(result.detail).toMatch(/^reboot loop: SW_CPU_RESET/);
    expect(uart[0]).toBe('boot\r\n'.repeat(6));
    expect(soc.boots).toBe(6);
    expect(soc.seconds()).toBeLessThan(10);
  }, 60_000);
});
