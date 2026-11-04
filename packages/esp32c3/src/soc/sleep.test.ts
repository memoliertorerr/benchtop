import { describe, expect, it } from 'vitest';
import { REF_HZ } from './context.ts';
import { RESET_REASON, WAKE } from './rtc-cntl.ts';
import { Esp32c3Soc } from './soc.ts';

// BT122: the C3's sleep on a bare SoC — SYSTEM's RTC fast memory CRC unit, RTC_CNTL's sleep and
// wake registers (the firmware's use of them is packages/parts/src/integration/sleep.test.ts).

const SLP_TIMER0 = 0x04;
const STATE0 = 0x18;
const WAKEUP_STATE = 0x3c;
const DIG_PWC = 0x88;
const SLP_WAKEUP_CAUSE = 0xf8;
const GPIO_WAKEUP = 0x110;

/** IDF's crc32_le(0xFFFFFFFF, …). */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return ~crc >>> 0;
}

describe('ESP32-C3 sleep (BT122)', () => {
  it('SYSTEM_RTC_FASTMEM_CONFIG: words of RTC fast memory CRC-32d at once, FINISH cleared with START', () => {
    const soc = new Esp32c3Soc();
    soc.memory.rtcFast.set([1, 2, 3, 4, 5, 6, 7, 8], 16);
    soc.system.write32(0x48, (1 << 8) | (4 << 9) | (2 << 20)); // words 4–5
    expect(soc.system.read32(0x48) >>> 31).toBe(1);
    expect(soc.system.read32(0x4c)).toBe(crc32(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)));
    soc.system.write32(0x48, 0);
    expect(soc.system.read32(0x48) >>> 31).toBe(0);
  });

  it('deep sleep on the timer: nothing runs asleep, then a DEEPSLEEP reset with the cause in SLP_WAKEUP_CAUSE', () => {
    const soc = new Esp32c3Soc();
    soc.rtc.write32(SLP_TIMER0, soc.rtc.rtcTime(0.5 * REF_HZ));
    soc.rtc.write32(WAKEUP_STATE, WAKE.TIMER << 15);
    soc.rtc.write32(DIG_PWC, 1 << 31);
    soc.rtc.write32(STATE0, 1 << 31);
    expect(soc.sleeping).toEqual({ deep: true });
    const before = soc.core.cycles;
    soc.runUntil(0.49 * REF_HZ);
    expect(soc.sleeping).not.toBeNull();
    expect(soc.core.cycles).toBe(before);
    soc.runUntil(0.6 * REF_HZ);
    expect(soc.sleeping).toBeNull();
    expect(soc.resetRequested).toBe(true);
    expect(soc.resetReason).toBe(RESET_REASON.DEEPSLEEP);
    expect(soc.rtc.read32(SLP_WAKEUP_CAUSE)).toBe(WAKE.TIMER);
    expect(soc.rtc.read32(STATE0) >>> 31).toBe(0);
    // The registers a system reset keeps go with it into the next chip.
    const next = new Esp32c3Soc({ time: soc.time });
    next.rtc.keepRtcDomain(soc.rtc.rtcDomain());
    expect(next.rtc.read32(SLP_WAKEUP_CAUSE)).toBe(WAKE.TIMER);
  });

  it('GPIO_WAKEUP: a pin (GPIO0–5) already at its level wakes the chip as it goes to sleep, its STATUS bit set', () => {
    const soc = new Esp32c3Soc();
    soc.gpio.setPadInput(4, 0);
    soc.rtc.write32(GPIO_WAKEUP, (1 << (31 - 4)) | (4 << (23 - 3 * 4))); // GPIO4, LOW
    soc.rtc.write32(WAKEUP_STATE, WAKE.GPIO << 15);
    soc.rtc.write32(DIG_PWC, 1 << 31);
    soc.rtc.write32(STATE0, 1 << 31);
    soc.runUntil(0.01 * REF_HZ);
    expect(soc.sleeping).toBeNull();
    expect(soc.rtc.read32(SLP_WAKEUP_CAUSE)).toBe(WAKE.GPIO);
    expect(soc.rtc.read32(GPIO_WAKEUP) & 0x3f).toBe(1 << 4);
  });

  it('light sleep: the timers wait, a later pin level wakes it, and the run goes on (no reset)', () => {
    const soc = new Esp32c3Soc();
    soc.gpio.setPadInput(4, 1);
    soc.rtc.write32(WAKEUP_STATE, WAKE.GPIO << 15);
    soc.rtc.write32(GPIO_WAKEUP, (1 << (31 - 4)) | (4 << (23 - 3 * 4)));
    soc.rtc.write32(STATE0, 1 << 31);
    expect(soc.sleeping).toEqual({ deep: false });
    soc.runUntil(0.2 * REF_HZ);
    expect(soc.sleeping).not.toBeNull();
    expect(soc.sleepWakes()).toEqual({ at: -1, pins: ['GPIO4 low'] }); // BT123: what the hosts show
    soc.gpio.setPadInput(4, 0);
    soc.runUntil(0.21 * REF_HZ);
    expect(soc.sleeping).toBeNull();
    expect(soc.resetRequested).toBe(false);
    expect(soc.rtc.read32(SLP_WAKEUP_CAUSE)).toBe(WAKE.GPIO);
  });
});
