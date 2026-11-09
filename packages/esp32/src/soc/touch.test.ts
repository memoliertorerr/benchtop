import { describe, expect, it } from 'vitest';
import { EventTable } from './events.ts';
import { ESP32_PAD_PF, Esp32Touch, RTC_IO_TOUCH_CFG, RTC_IO_TOUCH_PAD0, RTC_STATE0, RTC_TOUCH_INT, SENS_TOUCH_CTRL1, SENS_TOUCH_CTRL2, SENS_TOUCH_ENABLE, SENS_TOUCH_OUT1, SENS_TOUCH_THRES1 } from './touch.ts';

// BT159: the ESP32's touch sensor (version 1) on its own — RTC_CNTL's page (STATE0, RTC IO's
// touch registers) in a plain array, the time and events driven by hand.

const REF_HZ = 240_000_000;
const SLOW_HZ = 150_000;
/** Arduino's settings (esp32-hal-touch.c over IDF 4.4): a 4096-tick window, sleep 4096, 2.7 V / 0.5 V, no attenuation. */
const CFG = (3 << 29) | (0 << 27) | (3 << 25);
/** Cycles in a 4096-tick window at 8 MHz: 512 µs / (2·C·2.2 V / slope µA). */
const cycles = (pf: number, slope = 7, window = 4096): number => Math.floor(window / 8e6 / ((2 * pf * 1e-12 * 2.2) / (slope * 1e-6)));
const swap = (n: number): number => (n === 8 ? 9 : n === 9 ? 8 : n);

function rig(pf: Record<number, number> = {}) {
  const regs = new Uint32Array(1024);
  const events = new EventTable();
  let time = 0;
  const raises: number[] = [];
  const touch = new Esp32Touch({ events, now: () => (events.firing >= 0 ? events.firing : time) }, { read32: (o) => regs[o >>> 2], slowHz: () => SLOW_HZ, raise: (b) => raises.push(b) }, REF_HZ);
  touch.source = (g) => pf[g] ?? 0;
  regs[RTC_IO_TOUCH_CFG >>> 2] = CFG;
  for (let n = 0; n < 10; n++) regs[(RTC_IO_TOUCH_PAD0 >>> 2) + n] = 7 << 23;
  const run = (seconds: number): void => {
    const end = time + seconds * REF_HZ;
    while (events.next <= end) {
      time = events.next;
      events.fireDue(time);
    }
    time = end;
  };
  /** Pads `pads` in WORKEN and both sets (SENS bits: 8 ↔ 9), Arduino's window and sleep, timer mode on. */
  const timer = (pads: number[], ctrl1Extra = 0): void => {
    let bits = 0;
    for (const n of pads) bits |= 1 << swap(n);
    touch.write32(SENS_TOUCH_CTRL1, 4096 | (0xff << 16) | (1 << 25) | ctrl1Extra);
    touch.write32(SENS_TOUCH_ENABLE, bits | (bits << 10) | (bits << 20));
    touch.write32(SENS_TOUCH_CTRL2, (4096 << 14) | (1 << 11));
    regs[RTC_STATE0 >>> 2] = 1 << 23;
    touch.rtcWritten(RTC_STATE0, 1 << 23);
  };
  const out = (n: number): number => {
    const s = swap(n);
    const word = touch.read32(SENS_TOUCH_OUT1 + 4 * (s >>> 1));
    return (s & 1) === 0 ? word >>> 16 : word & 0xffff;
  };
  return { regs, touch, run, timer, out, raises, events };
}

describe('the ESP32 touch sensor (BT159)', () => {
  it('a reading is the charge cycles in the window: fewer with more capacitance, a lower slope or a wider swing', () => {
    const r = rig({ 4: 12, 0: 22 });
    r.timer([0, 1, 3]); // T0 (GPIO4), T1 (GPIO0), T3 (GPIO15)
    r.run(0.1);
    expect(r.out(0)).toBe(cycles(ESP32_PAD_PF + 12)); // 67
    expect(r.out(1)).toBe(cycles(ESP32_PAD_PF + 22)); // 37: touched
    expect(r.out(3)).toBe(cycles(ESP32_PAD_PF)); // 81: bare
    r.regs[(RTC_IO_TOUCH_PAD0 >>> 2) + 3] = 3 << 23;
    r.run(0.05);
    expect(r.out(3)).toBe(cycles(ESP32_PAD_PF, 3));
    r.regs[RTC_IO_TOUCH_CFG >>> 2] = (3 << 29) | (0 << 27) | (0 << 25); // 1.5 V attenuation: 0.7 V swing
    r.run(0.05);
    expect(r.out(0)).toBe(Math.floor(4096 / 8e6 / ((2 * 22e-12 * 0.7) / 7e-6)));
  });

  it('timer mode: a round every SLEEP_CYCLES slow-clock cycles after the last ends; MEAS_DONE clears while one runs', () => {
    const r = rig();
    r.timer([0, 2]);
    r.run(0.5);
    const round = (4096 / SLOW_HZ + (2 * (4096 + 255)) / 8e6) * REF_HZ;
    expect(r.touch.rounds).toBe(Math.floor((0.5 * REF_HZ) / round));
    expect(r.touch.read32(SENS_TOUCH_CTRL2) & (1 << 10)).not.toBe(0);
    r.regs[RTC_STATE0 >>> 2] = 0;
    r.touch.rtcWritten(RTC_STATE0, 0);
    const rounds = r.touch.rounds;
    r.run(0.2);
    expect(r.touch.rounds - rounds).toBeLessThanOrEqual(1);
  });

  it('software mode: one round per START_EN rising edge', () => {
    const r = rig({ 33: 5 });
    r.touch.write32(SENS_TOUCH_CTRL1, 4096);
    r.touch.write32(SENS_TOUCH_ENABLE, 1 << swap(8)); // T8 (GPIO33): SENS bit 9
    r.touch.write32(SENS_TOUCH_CTRL2, 1 << 13);
    r.touch.write32(SENS_TOUCH_CTRL2, (1 << 13) | (1 << 12));
    r.run(0.01);
    expect(r.touch.rounds).toBe(1);
    expect(r.out(8)).toBe(cycles(ESP32_PAD_PF + 5)); // in OUT5's high half (pad 9's slot)
    expect(r.touch.read32(SENS_TOUCH_OUT1 + 16) >>> 16).toBe(0);
    r.run(0.05);
    expect(r.touch.rounds).toBe(1);
    expect(r.touch.uses(33)).toBe(true);
    expect(r.touch.uses(32)).toBe(false);
  });

  it('a pad below its threshold sets MEAS_EN and raises TOUCH after every round while it stays below; MEAS_EN_CLR clears it; OUT_SEL turns it to above', () => {
    const pf: Record<number, number> = { 4: 2 };
    const r = rig(pf);
    r.timer([0, 9]);
    r.touch.write32(SENS_TOUCH_THRES1, 40 << 16); // T0 (slot 0: THRES1's high half)
    r.touch.write32(SENS_TOUCH_THRES1 + 16, 40 << 16); // T9's slot is 8 (THRES5's high half)
    expect(r.touch.read32(SENS_TOUCH_THRES1) >>> 16).toBe(40);
    r.run(0.2);
    expect(r.raises).toEqual([]);
    pf[4] = 12; // a finger: 37 < 40
    r.run(0.2);
    const n = r.raises.length;
    expect(n).toBeGreaterThan(3);
    expect(r.raises.every((b) => b === RTC_TOUCH_INT)).toBe(true);
    expect(r.touch.read32(SENS_TOUCH_CTRL2) & 0x3ff).toBe(1); // T0's SENS bit
    r.touch.write32(SENS_TOUCH_CTRL2, r.touch.read32(SENS_TOUCH_CTRL2) | (1 << 30));
    expect(r.touch.read32(SENS_TOUCH_CTRL2) & 0x3ff).toBe(0);
    pf[4] = 2;
    r.run(0.2);
    expect(r.raises.length).toBeLessThanOrEqual(n + 1);
    // Above: a bare pin's 81 is over 40.
    r.touch.write32(SENS_TOUCH_CTRL1, r.touch.read32(SENS_TOUCH_CTRL1) | (1 << 24));
    r.run(0.1);
    expect(r.touch.read32(SENS_TOUCH_CTRL2) & 0x3ff).toBe(1 | (1 << 8)); // T0 and T9 (SENS bit 8)
  });

  it('OUT_1EN 0: the interrupt needs a pad of both sets; a pad in neither never raises it', () => {
    const r = rig({ 4: 12, 0: 12 });
    r.timer([0, 1], 0);
    r.touch.write32(SENS_TOUCH_CTRL1, 4096 | (0xff << 16)); // OUT_1EN 0: both sets
    r.touch.write32(SENS_TOUCH_ENABLE, 0b11 | (0b10 << 10) | (0b01 << 20)); // T0 in SET1, T1 in SET2
    r.touch.write32(SENS_TOUCH_THRES1, (40 << 16) | 10); // T1's threshold 10: not triggered
    r.run(0.2);
    expect(r.raises).toEqual([]);
    r.touch.write32(SENS_TOUCH_THRES1, (40 << 16) | 40);
    r.run(0.2);
    expect(r.raises.length).toBeGreaterThan(0);
  });

  it('BT160: onFire runs after each round that would raise the interrupt; resume re-arms the FSM; wakePads lists SET1', () => {
    const pf: Record<number, number> = { 15: 2 };
    const r = rig(pf);
    let fired = 0;
    r.touch.onFire = () => fired++;
    r.timer([3]);
    r.touch.write32(SENS_TOUCH_THRES1 + 4, 40); // T3: slot 3, THRES2's low half
    expect(r.touch.wakePads()).toEqual([3]);
    r.run(0.1);
    expect(fired).toBe(0);
    pf[15] = 12;
    r.run(0.1);
    expect(fired).toBeGreaterThan(1);
    // A deep sleep clears the SoC's events: resume picks the timer up again.
    r.events.clear();
    const rounds = r.touch.rounds;
    r.run(0.1);
    expect(r.touch.rounds).toBe(rounds);
    r.touch.resume();
    r.run(0.1);
    expect(r.touch.rounds).toBeGreaterThan(rounds);
  });
});
