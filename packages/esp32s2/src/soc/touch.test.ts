import { EventTable } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import {
  PAD_PF,
  S2_TOUCH_INT,
  S2Touch,
  SAR_TOUCH_CHN_ST,
  SAR_TOUCH_CONF,
  SAR_TOUCH_STATUS0,
  SAR_TOUCH_STATUS1,
  SAR_TOUCH_THRES1,
  TOUCH_CTRL1,
  TOUCH_CTRL2,
  TOUCH_FILTER_CTRL,
  TOUCH_PAD0,
  TOUCH_SCAN_CTRL,
  TOUCH_TIMEOUT_CTRL,
} from './touch.ts';

// BT155: the S2's touch sensor on its own — RTC_CNTL's registers in a plain array, the time and
// the events driven by hand, the bench's capacitance a function per GPIO.

const REF_HZ = 240_000_000;
const SLOW_HZ = 90_000;

/** Arduino's settings (esp32-hal-touch.c over IDF 4.4): 500 cycles, sleep 15, 2.7 V / 0.5 V less 0.5 V. */
const CTRL1_DEFAULT = (500 << 16) | 0xf;
const CTRL2_VOLTS = (3 << 6) | (0 << 4) | (2 << 2);

function rig(pf: Record<number, number> = {}) {
  const regs = new Uint32Array(1024);
  const events = new EventTable();
  let time = 0;
  let raised = 0;
  const raises: { bits: number; at: number }[] = [];
  const touch = new S2Touch(
    { events, now: () => (events.firing >= 0 ? events.firing : time), hurry: () => {} },
    {
      read32: (offset) => regs[offset >>> 2],
      slowHz: () => SLOW_HZ,
      raise: (bits) => {
        raised |= bits;
        raises.push({ bits, at: time });
      },
    },
    REF_HZ,
  );
  touch.source = (g) => pf[g] ?? 0;
  const rtcWrite = (offset: number, value: number): void => {
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
  /** Channels `pads` in the scan map with slope 7 and OUTEN, Arduino's voltages and counts. */
  const configure = (pads: number[], ctrl2 = CTRL2_VOLTS): void => {
    regs[TOUCH_CTRL1 >>> 2] = CTRL1_DEFAULT;
    regs[TOUCH_CTRL2 >>> 2] = ctrl2;
    let map = 0;
    for (const n of pads) {
      regs[(TOUCH_PAD0 >>> 2) + n] = 7 << 23;
      map |= 1 << n;
    }
    touch.write32(SAR_TOUCH_CONF, map);
    rtcWrite(TOUCH_SCAN_CTRL, regs[TOUCH_SCAN_CTRL >>> 2] | (map << 10));
  };
  return { regs, touch, rtcWrite, run, configure, raised: () => raised, raises, clear: () => (raised = 0) };
}

/** 500 cycles of 2·C·1.7 V / 7 µA at 8 MHz. */
const ticks = (pf: number): number => Math.round(500 * ((2 * pf * 1e-12 * 1.7) / 7e-6) * 8e6);

describe('the S2 touch sensor (BT155)', () => {
  it('a software start measures each channel in the scan map once: MEAS_NUM charge cycles of the pad, in 8 MHz ticks', () => {
    const r = rig({ 5: 12 });
    r.configure([1, 5], CTRL2_VOLTS | (1 << 16)); // START_FORCE: software
    r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] | (1 << 15)); // START_EN
    r.run(0.003);
    expect(r.touch.measurements).toBe(1); // T1 done (2.4 ms), T5 still measuring (4.9 ms more)
    r.run(0.01);
    expect(r.touch.read32(SAR_TOUCH_STATUS1)).toBe(ticks(PAD_PF)); // 19,429 on a bare pin
    expect(r.touch.read32(SAR_TOUCH_STATUS1 + 16)).toBe(ticks(PAD_PF + 12));
    expect(r.raised() & (S2_TOUCH_INT.DONE | S2_TOUCH_INT.SCAN_DONE)).toBe(S2_TOUCH_INT.DONE | S2_TOUCH_INT.SCAN_DONE);
    expect(r.touch.read32(SAR_TOUCH_CHN_ST) >>> 31).toBe(1); // MEAS_DONE
    expect((r.touch.read32(SAR_TOUCH_STATUS0) >>> 22) & 0xf).toBe(5); // SCAN_CURR: the last channel read
    // Once per START_EN edge.
    const before = r.touch.measurements;
    r.run(0.05);
    expect(r.touch.measurements).toBe(before);
    expect(r.raises.filter((x) => (x.bits & S2_TOUCH_INT.SCAN_DONE) !== 0)).toHaveLength(1);
  });

  it('timer mode scans every SLEEP_CYCLES slow-clock cycles after the last scan while SLP_TIMER_EN is set', () => {
    const r = rig();
    r.configure([2]);
    r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] | (1 << 13)); // SLP_TIMER_EN
    r.run(0.1);
    const scans = r.raises.filter((x) => (x.bits & S2_TOUCH_INT.SCAN_DONE) !== 0).map((x) => x.at);
    const period = (15 / SLOW_HZ + ticks(PAD_PF) / 8e6) * REF_HZ; // ≈ 2.6 ms
    expect(scans.length).toBe(Math.floor((0.1 * REF_HZ) / period));
    for (let i = 1; i < scans.length; i++) expect(Math.abs(scans[i] - scans[i - 1] - period)).toBeLessThan(2);
    // Off: nothing more.
    r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] & ~(1 << 13));
    const count = r.raises.length;
    r.run(0.05);
    expect(r.raises.length - count).toBeLessThanOrEqual(2); // a measurement already under way ends (DONE, SCAN_DONE)
  });

  it('the reading scales with the capacitance, the voltage swing and the slope; slope 0 reads 0', () => {
    const r = rig({ 3: 22 });
    r.configure([3], CTRL2_VOLTS | (1 << 16));
    const scan = (): number => {
      r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] & ~(1 << 15));
      r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] | (1 << 15));
      r.run(0.02);
      return r.touch.read32(SAR_TOUCH_STATUS1 + 8);
    };
    expect(scan()).toBe(ticks(PAD_PF + 22));
    r.regs[(TOUCH_PAD0 >>> 2) + 3] = 3 << 23; // slope 3: 7/3 the time
    expect(scan()).toBe(Math.round(500 * ((2 * 32e-12 * 1.7) / 3e-6) * 8e6));
    r.regs[(TOUCH_PAD0 >>> 2) + 3] = 7 << 23;
    r.regs[TOUCH_CTRL2 >>> 2] = (r.regs[TOUCH_CTRL2 >>> 2] & ~(3 << 2)) | (3 << 2); // no attenuation: 2.2 V swing
    expect(scan()).toBe(Math.round(500 * ((2 * 32e-12 * 2.2) / 7e-6) * 8e6));
    r.regs[(TOUCH_PAD0 >>> 2) + 3] = 0;
    expect(scan()).toBe(0);
  });

  it('the first reading is the benchmark; a channel over benchmark + threshold is active (ACTIVE), back under it inactive (INACTIVE)', () => {
    const pf: Record<number, number> = { 5: 2 };
    const r = rig(pf);
    r.configure([5]);
    r.touch.write32(SAR_TOUCH_THRES1 + 16, 1500);
    r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] | (1 << 13));
    r.run(0.02);
    r.touch.write32(SAR_TOUCH_CONF, (r.touch.read32(SAR_TOUCH_CONF) & ~(3 << 16)) | (2 << 16)); // DATA_SEL: benchmark
    expect(r.touch.read32(SAR_TOUCH_STATUS1 + 16)).toBe(ticks(12));
    expect(r.touch.read32(SAR_TOUCH_CHN_ST) & 0x7fff).toBe(0);
    expect(r.raised() & S2_TOUCH_INT.ACTIVE).toBe(0);
    pf[5] = 12; // a finger
    r.run(0.01);
    expect(r.touch.read32(SAR_TOUCH_CHN_ST) & 0x7fff).toBe(1 << 5);
    expect(r.raised() & S2_TOUCH_INT.ACTIVE).not.toBe(0);
    expect(r.raises.filter((x) => (x.bits & S2_TOUCH_INT.ACTIVE) !== 0)).toHaveLength(1); // once, not every reading
    expect(r.touch.read32(SAR_TOUCH_STATUS1 + 16)).toBe(ticks(12)); // the benchmark stays without the filter
    pf[5] = 2;
    r.run(0.01);
    expect(r.touch.read32(SAR_TOUCH_CHN_ST) & 0x7fff).toBe(0);
    expect(r.raised() & S2_TOUCH_INT.INACTIVE).not.toBe(0);
    // A channel without OUTEN never goes active; STATUS_CLR clears the active bits; CHANNEL_CLR re-takes the benchmark.
    pf[5] = 12;
    r.run(0.01);
    r.touch.write32(SAR_TOUCH_CONF, r.touch.read32(SAR_TOUCH_CONF) | (1 << 15));
    expect(r.touch.read32(SAR_TOUCH_CHN_ST) & 0x7fff).toBe(0);
    r.touch.write32(SAR_TOUCH_CONF, r.touch.read32(SAR_TOUCH_CONF) & ~(1 << 5));
    r.touch.write32(SAR_TOUCH_CHN_ST, (1 << 5) << 15);
    r.run(0.01);
    expect(r.touch.read32(SAR_TOUCH_STATUS1 + 16)).toBe(ticks(22)); // the new benchmark, touched
    expect(r.touch.read32(SAR_TOUCH_CHN_ST) & 0x7fff).toBe(0);
  });

  it('with the filter on, the smoothed value follows by SMOOTH_LVL and the benchmark by FILTER_MODE; DEBOUNCE delays a change', () => {
    const pf: Record<number, number> = { 1: 0 };
    const r = rig(pf);
    r.configure([1]);
    r.regs[TOUCH_FILTER_CTRL >>> 2] = (1 << 31) | (0 << 28) | (2 << 25) | (1 << 9); // IIR4 benchmark, debounce 2, smooth IIR2
    r.touch.write32(SAR_TOUCH_THRES1, 100_000); // never active here
    r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] | (1 << 13));
    const period = 15 / SLOW_HZ + ticks(PAD_PF) / 8e6;
    r.run(period * 1.02); // one reading: the benchmark (the next measurement starts a sleep period later)
    pf[1] = 10;
    r.run(0.006); // the next reading (longer now)
    r.touch.write32(SAR_TOUCH_CONF, (r.touch.read32(SAR_TOUCH_CONF) & ~(3 << 16)) | (3 << 16));
    const base = ticks(PAD_PF);
    const high = ticks(PAD_PF + 10);
    const smooth = base + (high - base) / 2;
    expect(r.touch.read32(SAR_TOUCH_STATUS1)).toBe(Math.round(smooth));
    r.touch.write32(SAR_TOUCH_CONF, (r.touch.read32(SAR_TOUCH_CONF) & ~(3 << 16)) | (2 << 16));
    expect(r.touch.read32(SAR_TOUCH_STATUS1)).toBe(Math.round(base + (smooth - base) / 4));
    // Debounce 2: active on the third reading over the threshold.
    const r2 = rig({ 1: 0 });
    r2.configure([1]);
    r2.regs[TOUCH_FILTER_CTRL >>> 2] = (1 << 31) | (6 << 28) | (2 << 25);
    r2.touch.write32(SAR_TOUCH_THRES1, 1000);
    r2.rtcWrite(TOUCH_CTRL2, r2.regs[TOUCH_CTRL2 >>> 2] | (1 << 13));
    r2.run(0.0027); // the benchmark read, the next measurement not yet started
    r2.touch.source = () => 10;
    const active = (): number => r2.touch.read32(SAR_TOUCH_CHN_ST) & 2;
    let readings = 0;
    while (active() === 0 && readings < 10) {
      const n = r2.touch.measurements;
      while (r2.touch.measurements === n) r2.run(0.0005);
      readings++;
    }
    expect(readings).toBe(3);
  });

  it('denoise: channel 0 measures REFC first, and its reading at DENOISE_RES is subtracted from each channel', () => {
    const r = rig();
    r.configure([4], CTRL2_VOLTS | (1 << 16) | (4 << 9)); // REFC L4: 10.6 pF
    r.rtcWrite(TOUCH_SCAN_CTRL, r.regs[TOUCH_SCAN_CTRL >>> 2] | (1 << 2) | 3); // DENOISE_EN, 4 bits
    r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] | (1 << 15));
    r.run(0.02);
    expect(r.touch.read32(SAR_TOUCH_STATUS0) & 0x3fffff).toBe(ticks(10.6));
    expect(r.touch.read32(SAR_TOUCH_STATUS1 + 12)).toBe(ticks(PAD_PF) - 15);
    r.rtcWrite(TOUCH_SCAN_CTRL, (r.regs[TOUCH_SCAN_CTRL >>> 2] & ~3) | 0); // 12 bits
    r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] & ~(1 << 15));
    r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] | (1 << 15));
    r.run(0.02);
    expect(r.touch.read32(SAR_TOUCH_STATUS1 + 12)).toBe(ticks(PAD_PF) - 4095);
  });

  it('a reading over TIMEOUT_NUM with TIMEOUT_EN raises TIMEOUT and is dropped; RESET clears every channel', () => {
    const r = rig({ 1: 100 });
    r.configure([1], CTRL2_VOLTS | (1 << 16));
    r.regs[TOUCH_TIMEOUT_CTRL >>> 2] = (1 << 22) | 50_000;
    r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] | (1 << 15));
    r.run(0.05);
    expect(r.raised() & S2_TOUCH_INT.TIMEOUT).not.toBe(0);
    expect(r.touch.read32(SAR_TOUCH_STATUS1)).toBe(0);
    r.regs[TOUCH_TIMEOUT_CTRL >>> 2] = 0;
    r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] & ~(1 << 15));
    r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] | (1 << 15));
    r.run(0.05);
    expect(r.touch.read32(SAR_TOUCH_STATUS1)).toBe(ticks(PAD_PF + 100));
    r.rtcWrite(TOUCH_CTRL2, r.regs[TOUCH_CTRL2 >>> 2] | (1 << 29));
    expect(r.touch.read32(SAR_TOUCH_STATUS1)).toBe(0);
  });
});
