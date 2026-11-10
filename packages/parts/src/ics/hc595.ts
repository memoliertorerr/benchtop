/**
 * BT184: the 74HC595 8-bit shift register with output latches (`74hc595`), a DIP-16 that straddles
 * the breadboard's centre gap. Pins by NXP's names, TI's in brackets: DS [SER] serial data, SHCP
 * [SRCLK] shift clock, STCP [RCLK] storage clock, MR [SRCLR] reset (active low), OE (active low),
 * Q0–Q7 [QA–QH] outputs, Q7S [QH′] serial out, VCC, GND — both datasheets' pinout (pin 1 Q1 … 7
 * Q7, 8 GND, 9 Q7S, 10 MR, 11 SHCP, 12 STCP, 13 OE, 14 DS, 15 Q0, 16 VCC).
 *
 * The function table: SHCP ↑ shifts DS into stage 0 (stage 7 goes out on Q7S) while MR is high;
 * MR low clears the shift register; STCP ↑ copies the shift register to the storage register, which
 * drives Q0–Q7 while OE is low and lets them go while it is high. Powered means VCC at 2 V or more
 * over GND (the datasheet's 2–6 V); unpowered it drives nothing, and it powers up cleared. A high
 * output drives VCC's volts. Q7S changes with the shift, on SHCP ↑, as the chip's does: the bench's
 * resolver applies a drive made inside a listener after every listener of that edge has run, so the
 * next 595 of a chain samples the old bit whatever order the parts were placed in.
 *
 * Hardware SPI reaches it through `attachSpi` with GND as the select — it shifts whatever its clock
 * brings, and its latch is not a select: a byte (MSB first) becomes the shift register, and the
 * byte it held is what it shifts out, which the bench hands the next part of a chain. A hardware SPI
 * byte toggles no pin, so the two paths never both see one. SPI modes that sample on the falling
 * edge (1 and 2) aren't seen: the bus is transaction-level, so they shift as mode 0 would.
 *
 * Visual: `q`, the eight outputs as a byte (bit n = Qn high; 0 while released or unpowered).
 */

import { type NetState, type PinDef, type SpiDevice, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';

/** VCC over GND at or above this powers the chip (the datasheet's 2 V minimum). */
export const HC595_MIN_VOLTS = 2;

/** DIP-16 seen from above, notch on the left: pins 1–8 along the bottom, 9–16 back along the top. */
const DIP_ROW = 7.62;
const DIP_NAMES = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'GND', 'Q7S', 'MR', 'SHCP', 'STCP', 'OE', 'DS', 'Q0', 'VCC'] as const;

/** A DIP's pins, pin 1 at the bottom left; `names[i]` is pin i + 1. */
export function dipPins(names: readonly string[], role: (name: string) => PinDef['role']): PinDef[] {
  const half = names.length / 2;
  return names.map((name, i) => ({
    name,
    x: 1.27 + 2.54 * (i < half ? i : names.length - 1 - i),
    y: i < half ? 1.27 + DIP_ROW : 1.27,
    role: role(name),
  }));
}

const high = (s: NetState): boolean => s.level === 1;

export const hc595 = definePart({
  type: '74hc595',
  title: '74HC595 shift register',
  category: 'ics',
  size: { w: 20.32, h: 10.16 },
  pins: dipPins(DIP_NAMES, (name) => (name === 'VCC' ? 'power' : name === 'GND' ? 'ground' : 'digital')),
  defaults: {},
  createModel(ctx) {
    const ds = ctx.pin('DS');
    const shcp = ctx.pin('SHCP');
    const stcp = ctx.pin('STCP');
    const mr = ctx.pin('MR');
    const oe = ctx.pin('OE');
    const q7s = ctx.pin('Q7S');
    const vcc = ctx.pin('VCC');
    const gnd = ctx.pin('GND');
    const outs = [ctx.pin('Q0'), ctx.pin('Q1'), ctx.pin('Q2'), ctx.pin('Q3'), ctx.pin('Q4'), ctx.pin('Q5'), ctx.pin('Q6'), ctx.pin('Q7')];
    let powered = false;
    let volts = 0;
    let shift = 0;
    let storage = 0;
    let shown = -1;
    let clock = false;
    let latch = false;
    const visual = { q: 0 };

    /** The outputs as the chip drives them now (−1 = released). */
    const drive = (): void => {
      const on = powered && oe.read().level === 0;
      const q = on ? storage : -1;
      if (q === shown) return;
      shown = q;
      for (let n = 0; n < 8; n++) {
        if (!on) outs[n].release();
        else if ((storage >> n) & 1) outs[n].driveVolts(volts, Strength.strong);
        else outs[n].drive(0, Strength.strong);
      }
      visual.q = on ? storage : 0;
      ctx.invalidate();
    };
    const driveSerial = (): void => {
      if (!powered) q7s.release();
      else if (shift & 0x80) q7s.driveVolts(volts, Strength.strong);
      else q7s.drive(0, Strength.strong);
    };
    const checkPower = (): void => {
      const v = vcc.read();
      const g = gnd.read();
      const on = v.level === 1 && g.level === 0 && v.volts - g.volts >= HC595_MIN_VOLTS;
      volts = on ? v.volts : 0;
      if (on !== powered) {
        powered = on;
        shift = 0;
        storage = 0;
        clock = high(shcp.read());
        latch = high(stcp.read());
        shown = -2; // redrive
      }
      drive();
      driveSerial();
    };

    shcp.onChange((s) => {
      const rising = high(s);
      if (rising === clock) return;
      clock = rising;
      if (!powered || !rising || !high(mr.read())) return;
      shift = ((shift << 1) | (high(ds.read()) ? 1 : 0)) & 0xff;
      driveSerial();
    });
    stcp.onChange((s) => {
      const rising = high(s);
      if (rising === latch) return;
      latch = rising;
      if (!powered || !rising) return;
      storage = shift;
      drive();
    });
    mr.onChange((s) => {
      if (!powered || high(s)) return;
      shift = 0;
      driveSerial();
    });
    oe.onChange(drive);
    vcc.onChange(checkPower);
    gnd.onChange(checkPower);

    const device: SpiDevice = {
      transfer(mosi: number): number {
        if (!powered) return 0xff;
        if (!high(mr.read())) return 0; // held clear: it shifts out zeros and keeps none
        const out = shift;
        shift = mosi & 0xff;
        driveSerial();
        return out;
      },
    };
    ctx.attachSpi({ sck: 'SHCP', mosi: 'DS', miso: 'Q7S', cs: 'GND' }, device);
    checkPower();

    return {
      reset() {
        powered = false;
        checkPower();
      },
      visual: () => visual,
    };
  },
});
