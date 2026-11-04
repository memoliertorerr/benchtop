import { describe, expect, it } from 'vitest';
import { createTestSoc } from '../test-support/soc.test-helper.ts';
import { REF_HZ } from './context.ts';
import { RTC_FAST, RTC_SLOW } from './memory.ts';
import { RESET_REASON } from './reset.ts';
import { RTC, RTC_SLOW_HZ, WAKE } from './rtc-cntl.ts';

// BT121: RTC_CNTL's sleep and its CRC unit on a bare SoC (the firmware's use of them is
// packages/parts/src/integration/sleep.test.ts).

/** IDF's crc32_le(0xFFFFFFFF, …) — the reflected CRC-32 from 0, inverted at the end. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return ~crc >>> 0;
}

describe('RTC_CNTL sleep (BT121)', () => {
  it('the CRC unit (RTC_MEM_CONF): words of RTC fast memory, FINISH set at once, cleared with START', () => {
    const soc = createTestSoc();
    const fast = soc.memory.bytes.subarray(RTC_FAST.offset, RTC_FAST.offset + RTC_FAST.size);
    fast.set([1, 2, 3, 4, 5, 6, 7, 8], 16);
    soc.rtc.write32(RTC.MEM_CONF, (1 << 8) | (4 << 9) | (2 << 20)); // words 4–5: bytes 16–23
    expect(soc.rtc.read32(RTC.MEM_CONF) >>> 31).toBe(1);
    expect(soc.rtc.read32(RTC.MEM_CRC_RES)).toBe(crc32(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)));
    soc.rtc.write32(RTC.MEM_CONF, 0);
    expect(soc.rtc.read32(RTC.MEM_CONF) >>> 31).toBe(0);
  });

  it('deep sleep on the timer: no instructions while asleep, then a DEEPSLEEP reset keeping the RTC domain', () => {
    const soc = createTestSoc();
    soc.memory.bytes[RTC_SLOW.offset] = 0x5a; // RTC_DATA_ATTR
    soc.memory.bytes[RTC_FAST.offset] = 0xa5;
    soc.rtc.write32(RTC.STORE0, 0x1234);
    const wakeAt = Math.round(0.5 * RTC_SLOW_HZ); // 0.5 s of RTC slow ticks
    soc.rtc.write32(RTC.SLP_TIMER0, wakeAt);
    soc.rtc.write32(RTC.WAKEUP_STATE, WAKE.TIMER << 11);
    soc.rtc.write32(RTC.DIG_PWC, 1 << 31);
    soc.rtc.write32(RTC.STATE0, 1 << 31);
    expect(soc.sleeping).toMatchObject({ deep: true });
    const before = soc.cores[0].cycles;
    soc.runUntil(0.49 * REF_HZ);
    expect(soc.sleeping).not.toBeNull();
    expect(soc.cores[0].cycles).toBe(before); // asleep: nothing runs
    soc.runUntil(0.6 * REF_HZ);
    expect(soc.sleeping).toBeNull();
    expect(soc.rtc.read32(RTC.WAKEUP_STATE) & 0x7ff).toBe(WAKE.TIMER); // the cause, kept through the reset
    expect(soc.rtc.read32(RTC.RESET_STATE) & 0x3f).toBe(RESET_REASON.DEEPSLEEP);
    expect(soc.rtc.read32(RTC.STORE0)).toBe(0x1234);
    expect(soc.memory.bytes[RTC_SLOW.offset]).toBe(0x5a);
    expect(soc.memory.bytes[RTC_FAST.offset]).toBe(0xa5);
    expect(soc.rtc.read32(RTC.STATE0) >>> 31).toBe(0); // SLEEP_EN off
  });

  it('ext0 and ext1 hold at once: a pin already at its level wakes the chip as it goes to sleep', () => {
    const soc = createTestSoc();
    soc.gpio.setPadInput(33, 0);
    soc.rtc.write32(0x400 + 0xbc, 8 << 27); // RTC_IO EXT_WAKEUP0: RTC GPIO 8 = GPIO33, LOW (EXT_WAKEUP0_LV 0)
    soc.rtc.write32(RTC.WAKEUP_STATE, WAKE.EXT0 << 11);
    soc.rtc.write32(RTC.DIG_PWC, 1 << 31);
    soc.rtc.write32(RTC.STATE0, 1 << 31);
    soc.runUntil(0.01 * REF_HZ);
    expect(soc.sleeping).toBeNull();
    expect(soc.rtc.read32(RTC.WAKEUP_STATE) & 0x7ff).toBe(WAKE.EXT0);
  });
});
