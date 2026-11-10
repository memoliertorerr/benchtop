/**
 * BT193: the 74HC165 8-bit parallel-in/serial-out shift register (`74hc165`), a DIP-16 like the 595.
 * Pins by NXP's names, TI's in brackets: PL [SH/LD] parallel load (active low), CP [CLK] clock, CE
 * [CLK INH] clock enable (active low), DS [SER] serial in, D0–D7 [A–H] parallel inputs, Q7 [QH] and
 * Q7N [Q̅H] the last stage and its complement — pin 1 PL, 2 CP, 3–6 D4–D7, 7 Q7N, 8 GND, 9 Q7, 10 DS,
 * 11–14 D0–D3, 15 CE, 16 VCC.
 *
 * The function table: while PL is low the eight stages follow D0–D7 (asynchronous; D7 is on Q7);
 * with PL high, a rising edge of CP OR CE (the gated-OR clock: CE high holds it) shifts — stage 0
 * takes DS, each stage the one before it, Q7 the next bit. Powered means VCC at 2 V or more over GND;
 * outputs drive VCC's volts.
 *
 * Hardware SPI: `attachSpi` with CE as the select and DS as its MOSI — a read-only device (the bench
 * attaches it by SCK and MISO when DS is unwired, on a rail, or another 165's Q7). A byte reads the
 * eight stages MSB first (D7 first, as an SPI mode 0 master samples Q7 before each shift) and shifts
 * in DS's level when it sits on a rail, else what the bench hands it (the next 165's byte in a chain).
 * While PL is low a byte reads D7 eight times.
 *
 * Visual: `q` — the stages as a byte (bit n = stage n).
 */

import { type NetState, type SpiDevice, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { dipPins } from './hc595.ts';

const NAMES = ['PL', 'CP', 'D4', 'D5', 'D6', 'D7', 'Q7N', 'GND', 'Q7', 'DS', 'D0', 'D1', 'D2', 'D3', 'CE', 'VCC'] as const;
const high = (s: NetState): boolean => s.level === 1;

export const hc165 = definePart({
  type: '74hc165',
  title: '74HC165 shift register (parallel in)',
  category: 'ics',
  size: { w: 20.32, h: 10.16 },
  pins: dipPins(NAMES, (name) => (name === 'VCC' ? 'power' : name === 'GND' ? 'ground' : 'digital')),
  defaults: {},
  createModel(ctx) {
    const pl = ctx.pin('PL');
    const cp = ctx.pin('CP');
    const ce = ctx.pin('CE');
    const ds = ctx.pin('DS');
    const q7 = ctx.pin('Q7');
    const q7n = ctx.pin('Q7N');
    const vcc = ctx.pin('VCC');
    const gnd = ctx.pin('GND');
    const inputs = [ctx.pin('D0'), ctx.pin('D1'), ctx.pin('D2'), ctx.pin('D3'), ctx.pin('D4'), ctx.pin('D5'), ctx.pin('D6'), ctx.pin('D7')];
    let powered = false;
    let volts = 0;
    let stages = 0;
    let clock = false;
    let driven = -1;
    const visual = { q: 0 };

    const parallel = (): number => {
      let v = 0;
      for (let n = 0; n < 8; n++) if (high(inputs[n].read())) v |= 1 << n;
      return v;
    };
    const drive = (): void => {
      const bit = powered ? (stages >> 7) & 1 : -1;
      if (bit !== driven) {
        driven = bit;
        if (bit < 0) {
          q7.release();
          q7n.release();
        } else if (bit === 1) {
          q7.driveVolts(volts, Strength.strong);
          q7n.drive(0, Strength.strong);
        } else {
          q7.drive(0, Strength.strong);
          q7n.driveVolts(volts, Strength.strong);
        }
      }
      if (visual.q !== stages) {
        visual.q = stages;
        ctx.invalidate();
      }
    };
    const loading = (): boolean => pl.read().level === 0;
    const follow = (): void => {
      if (!powered || !loading()) return;
      stages = parallel();
      drive();
    };
    const gatedClock = (): boolean => high(cp.read()) || high(ce.read());
    const onClock = (): void => {
      const now = gatedClock();
      if (now === clock) return;
      clock = now;
      if (!powered || !now || loading()) return;
      stages = ((stages << 1) | (high(ds.read()) ? 1 : 0)) & 0xff;
      drive();
    };
    const checkPower = (): void => {
      const v = vcc.read();
      const g = gnd.read();
      const on = v.level === 1 && g.level === 0 && v.volts - g.volts >= 2;
      volts = on ? v.volts : 0;
      if (on !== powered) {
        powered = on;
        stages = 0;
        clock = gatedClock();
        driven = -2;
      } else driven = -2; // VCC's volts may have changed
      follow();
      drive();
    };

    pl.onChange(follow);
    for (const pin of inputs) pin.onChange(follow);
    cp.onChange(onClock);
    ce.onChange(onClock);
    vcc.onChange(checkPower);
    gnd.onChange(checkPower);

    const device: SpiDevice = {
      transfer(mosi: number): number {
        if (!powered) return 0xff;
        if (loading()) return (stages >> 7) & 1 ? 0xff : 0;
        const out = stages;
        const serial = ds.read();
        const shiftedIn = serial.strength === Strength.supply ? (serial.level === 1 ? 0xff : 0) : mosi & 0xff;
        stages = shiftedIn;
        drive();
        return out;
      },
    };
    ctx.attachSpi({ sck: 'CP', mosi: 'DS', miso: 'Q7', cs: 'CE' }, device);
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
