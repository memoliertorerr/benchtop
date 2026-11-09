import { EventTable } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { REF_HZ, S3RtcCntl } from './rtc-cntl.ts';
import { PAD_PF, S3_TOUCH_CHIP, TOUCH_INT, TouchV2 } from './touch.ts';

// BT158: the version-2 touch model at the S3's offsets (the S2's are covered by @benchtop/esp32s2's
// touch tests on the same model) and the S3's RTC_CNTL interrupt line with INT_ENA_W1TS/W1TC.

const c = S3_TOUCH_CHIP;
/** 500 cycles of 2·C·1.7 V / (slope µA) at 8 MHz. */
const ticks = (pf: number, slope = 7): number => Math.round(500 * ((2 * pf * 1e-12 * 1.7) / (slope * 1e-6)) * 8e6);

function rig(pf: Record<number, number> = {}) {
  const regs = new Uint32Array(1024);
  const events = new EventTable();
  let time = 0;
  let raised = 0;
  const touch = new TouchV2({ events, now: () => (events.firing >= 0 ? events.firing : time), hurry: () => {} }, { read32: (o) => regs[o >>> 2], slowHz: () => 136_000, raise: (b) => (raised |= b) }, REF_HZ, c);
  touch.source = (g) => pf[g] ?? 0;
  const write = (offset: number, value: number): void => {
    const before = regs[offset >>> 2];
    regs[offset >>> 2] = value;
    touch.rtcWritten(offset, value, before);
  };
  const run = (seconds: number): void => {
    const end = time + seconds * REF_HZ;
    while (events.next <= end) {
      time = events.next;
      events.fireDue(time);
    }
    time = end;
  };
  return { regs, touch, write, run, raised: () => raised };
}

describe('the S3’s touch sensor (BT158)', () => {
  it('reads its controls at the S3’s RTC_CNTL offsets, each pad’s slope from TOUCH_DAC/TOUCH_DAC1, its data at the S3’s SENS offsets', () => {
    const r = rig({ 3: 12, 12: 12 });
    r.regs[c.ctrl1 >>> 2] = (500 << 16) | 0xf;
    r.regs[0x14c >>> 2] = (7 << (29 - 3 * 3)) >>> 0; // pad 3: slope 7
    r.regs[0x150 >>> 2] = (5 << (29 - 3 * 2)) >>> 0; // pad 12: slope 5
    r.touch.write32(c.conf, (1 << 3) | (1 << 12));
    r.write(c.scanCtrl, ((1 << 3) | (1 << 12)) << 10);
    r.write(c.ctrl2, (3 << 6) | (2 << 2) | (1 << 16));
    r.write(c.ctrl2, (3 << 6) | (2 << 2) | (1 << 16) | (1 << 15)); // a software start
    r.run(0.05);
    expect(r.touch.read32(c.status1 + 4 * 2)).toBe(ticks(PAD_PF + 12)); // TOUCH3 at STATUS3 (0xAC)
    expect(r.touch.read32(c.status1 + 4 * 11)).toBe(ticks(PAD_PF + 12, 5)); // TOUCH12 at STATUS12
    expect(r.touch.read32(c.chnSt) >>> 31).toBe(1);
    expect((r.touch.read32(c.status0) >>> 22) & 0xf).toBe(12);
    expect(r.raised() & TOUCH_INT.SCAN_DONE).not.toBe(0);
    r.touch.write32(c.thres1 + 4 * 2, 1234);
    expect(r.touch.read32(c.thres1 + 4 * 2)).toBe(1234);
    expect(r.touch.owns(0x5c) && r.touch.owns(0xe0) && !r.touch.owns(0x58) && !r.touch.owns(0xe4)).toBe(true);
  });

  it('RTC_CNTL’s interrupt follows INT_RAW & INT_ENA, enabled through INT_ENA_W1TS (0x138) and cleared through W1TC (0x13C)', () => {
    const rtc = new S3RtcCntl(() => 0);
    const lines: boolean[] = [];
    rtc.onInterrupt = (on) => lines.push(on);
    rtc.raise(TOUCH_INT.ACTIVE);
    expect(lines).toEqual([]); // not enabled
    rtc.write32(0x138, TOUCH_INT.ACTIVE | TOUCH_INT.INACTIVE);
    expect(rtc.read32(0x40)).toBe(TOUCH_INT.ACTIVE | TOUCH_INT.INACTIVE);
    expect(rtc.read32(0x48)).toBe(TOUCH_INT.ACTIVE); // INT_ST
    expect(lines).toEqual([true]);
    rtc.write32(0x4c, TOUCH_INT.ACTIVE); // INT_CLR
    expect(lines).toEqual([true, false]);
    rtc.raise(TOUCH_INT.INACTIVE);
    rtc.write32(0x13c, TOUCH_INT.INACTIVE); // W1TC
    expect(rtc.read32(0x40)).toBe(TOUCH_INT.ACTIVE);
    expect(lines).toEqual([true, false, true, false]);
  });

  it('BT160: the sleep pad over its sleep threshold calls onSleepPad; the RTC domain keeps TOUCH_SLP_THRES; wakePins names the pad', () => {
    const pf: Record<number, number> = { 3: 2 };
    const r = rig(pf);
    let woken = 0;
    r.touch.onSleepPad = () => woken++;
    r.regs[c.ctrl1 >>> 2] = (500 << 16) | 0xf;
    r.regs[0x14c >>> 2] = (7 << (29 - 3 * 3)) >>> 0;
    r.regs[c.slpThres >>> 2] = ((3 << 27) | 5000) >>> 0; // sleep pad T3, threshold 5000
    r.touch.write32(c.conf, 1 << 3);
    r.write(c.scanCtrl, (1 << 3) << 10);
    r.write(c.ctrl2, (3 << 6) | (2 << 2) | (1 << 13)); // timer mode, SLP_TIMER_EN
    r.run(0.05);
    expect(woken).toBe(0);
    expect(r.touch.sleepPad()).toBe(3);
    pf[3] = 12; // +10 pF: ≈ 19,400 over the benchmark
    r.run(0.05);
    expect(woken).toBeGreaterThan(0);
    const rtc = new S3RtcCntl(() => 0);
    rtc.write32(0x3c, (1 << 8) << 15); // WAKEUP_STATE: TOUCH
    rtc.write32(c.slpThres, ((3 << 27) | 5000) >>> 0);
    expect(rtc.wakePins()).toEqual(['touch T3 (GPIO3)']);
    const kept = rtc.rtcDomain();
    const after = new S3RtcCntl(() => 0);
    after.keepRtcDomain(kept);
    expect(after.read32(c.slpThres) >>> 27).toBe(3);
  });
});
