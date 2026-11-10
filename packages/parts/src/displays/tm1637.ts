/**
 * BT186: the TM1637 4-digit module (`tm1637-4digit`): Titan Micro's TM1637 LED driver (datasheet
 * V2.1) behind the common 0.36″ clock display — four digits and the colon, pins CLK, DIO, VCC, GND,
 * and 10 kΩ pull-ups on CLK and DIO (the driver libraries release a line to send a 1).
 *
 * The two-wire bus, decoded from the pins: START is DIO falling while CLK is high, STOP DIO rising
 * while CLK is high; between them bytes go LSB first, DIO changing while CLK is low and read on
 * its rising edge. After each byte the chip pulls DIO low from the eighth clock's falling edge to
 * the ninth's (the ACK). A STOP inside a byte drops it. The first byte after START is a command
 * (B7 B6): 01 data (B1 = 1 reads the keys, B2 = 1 a fixed address instead of auto-increment), 11
 * address (C0h–C5h; C6h and up ignore data until a valid address), 10 display control (B3 on, B2–B0
 * the pulse width 1/16, 2/16, 4/16, 10/16, 11/16, 12/16, 13/16, 14/16). Bytes after an address
 * command go to the display registers 00h–05h (B0 SEG1 … B7 SEG8). A key read answers 0xFF (no key
 * pressed: the module wires none), LSB first, changing on CLK's falling edges. Power-up: display
 * off, registers 0, address 00h.
 *
 * The module wires GRID1–GRID4 to the digits left to right, SEG1–SEG7 to segments A–G and SEG8 of
 * GRID2 to the colon (as TM1637Display's dots bit 0x40 expects); the other DP bits light nothing.
 * Powered means VCC at 3 V or more over GND (decided: the datasheet specifies 5 V ± 10 %, and the
 * modules are commonly run from 3.3 V boards).
 *
 * Visual: `values` (8 per digit: A–G, DP — always 0 — at the pulse width while lit, as the
 * 7-segment parts), `colon`, `segments` (each digit's lit segments, A bit 0 … G bit 6) and `level`
 * (the pulse width while on, else 0), so readers see a dim digit as lit.
 */

import { type NetState, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';

/** VCC over GND at or above this powers it (decided; the datasheet's range is 4.5–5.5 V). */
export const TM1637_MIN_VOLTS = 3;

/** Display control B2–B0 → pulse width (sixteenths). */
export const TM1637_PULSE = [1, 2, 4, 10, 11, 12, 13, 14] as const;

/** The TM1637's registers and its bus decoder; pins and drives belong to the part's model. */
export class Tm1637 {
  readonly ram = new Uint8Array(6);
  on = false;
  pulse = 0;
  address = 0;
  fixed = false;
  reading = false;
  /** In a transaction (after START, before STOP). */
  active = false;
  /** Bytes received in this transaction. */
  count = 0;
  /** Rising edges in the current byte (9 = the ACK clock). */
  bits = 0;
  byte = 0;
  /** What the chip holds DIO at: −1 released, 0 low. */
  dio = -1;
  /** Bytes the chip is sending this transaction (key reads). */
  sending = false;

  powerOn(): void {
    this.ram.fill(0);
    this.on = false;
    this.pulse = 0;
    this.address = 0;
    this.fixed = false;
    this.reading = false;
    this.endTransaction();
  }

  private endTransaction(): void {
    this.active = false;
    this.count = 0;
    this.bits = 0;
    this.byte = 0;
    this.dio = -1;
    this.sending = false;
  }

  start(): void {
    this.endTransaction();
    this.active = true;
  }

  stop(): void {
    this.endTransaction();
  }

  /** CLK ↑ with DIO at `level`. */
  rise(level: number): void {
    if (!this.active) return;
    if (this.bits < 8) {
      if (!this.sending) this.byte |= (level & 1) << this.bits;
      this.bits++;
    } else if (this.bits === 8) this.bits = 9;
  }

  /** CLK ↓: the ACK starts after the eighth bit and ends after the ninth; key bits change here. Returns true when a byte arrived. */
  fall(): boolean {
    if (!this.active) return false;
    if (this.bits === 8 && this.dio !== 0) {
      const received = !this.sending;
      if (received) this.receive(this.byte);
      this.dio = 0;
      return received;
    }
    if (this.bits === 9) {
      this.bits = 0;
      this.byte = 0;
      this.dio = -1;
      if (this.reading && this.count === 1) this.sending = true; // after a key-read command, the keys
      return false;
    }
    if (this.sending && this.bits < 8) this.dio = -1; // 0xFF: every key bit released
    return false;
  }

  private receive(byte: number): void {
    const first = this.count === 0;
    this.count++;
    if (first) {
      const kind = byte >> 6;
      if (kind === 0b01) {
        this.reading = (byte & 0x03) === 0x02;
        this.fixed = (byte & 0x04) !== 0;
      } else if (kind === 0b11) this.address = byte & 0x3f;
      else if (kind === 0b10) {
        this.on = (byte & 0x08) !== 0;
        this.pulse = TM1637_PULSE[byte & 0x07];
      }
      return;
    }
    if (this.address < 6) this.ram[this.address] = byte;
    if (!this.fixed && this.address < 6) this.address++;
  }

  /** Light of a lit segment (0 while off). */
  get level(): number {
    return this.on ? this.pulse / 16 : 0;
  }
}

const high = (s: NetState): boolean => s.level === 1;

export const tm1637FourDigit = definePart({
  type: 'tm1637-4digit',
  title: 'TM1637 4-digit display',
  category: 'displays',
  size: { w: 42.0, h: 24.13 },
  pins: [
    { name: 'CLK', x: 1.27, y: 8.255, role: 'digital' },
    { name: 'DIO', x: 1.27, y: 10.795, role: 'digital' },
    { name: 'VCC', x: 1.27, y: 13.335, role: 'power' },
    { name: 'GND', x: 1.27, y: 15.875, role: 'ground' },
  ],
  defaults: {},
  createModel(ctx) {
    const chip = new Tm1637();
    const clk = ctx.pin('CLK');
    const dio = ctx.pin('DIO');
    const vcc = ctx.pin('VCC');
    const gnd = ctx.pin('GND');
    const values: number[] = new Array<number>(32).fill(0);
    const segments: number[] = [0, 0, 0, 0];
    const visual = { values, colon: 0, segments, level: 0 };
    let powered = false;
    let volts = 0;
    let clock = true;
    let data = true;
    let held = -2;

    /** DIO: the chip's low, else the module's pull-up. */
    const driveDio = (): void => {
      const want = powered ? chip.dio : -2;
      if (want === held) return;
      held = want;
      if (want === 0) dio.drive(0, Strength.strong);
      else if (want === -1) dio.driveVolts(volts, Strength.weak);
      else dio.release();
    };
    const show = (): void => {
      const level = powered ? chip.level : 0;
      visual.level = level;
      for (let d = 0; d < 4; d++) {
        const bits = powered ? chip.ram[d] & 0x7f : 0;
        segments[d] = level > 0 ? bits : 0;
        for (let s = 0; s < 8; s++) values[d * 8 + s] = s < 7 && (bits >> s) & 1 ? level : 0;
      }
      visual.colon = powered && chip.ram[1] & 0x80 ? level : 0;
      ctx.invalidate();
    };
    const checkPower = (): void => {
      const v = vcc.read();
      const g = gnd.read();
      const on = v.level === 1 && g.level === 0 && v.volts - g.volts >= TM1637_MIN_VOLTS;
      volts = on ? v.volts : 0;
      if (on !== powered) {
        powered = on;
        chip.powerOn();
        if (on) clk.driveVolts(volts, Strength.weak);
        else clk.release();
        held = -2;
        driveDio();
        clock = high(clk.read());
        data = high(dio.read());
        show();
      } else if (on) {
        clk.driveVolts(volts, Strength.weak);
        held = -2;
        driveDio();
      }
    };

    clk.onChange((s) => {
      const rising = high(s);
      if (rising === clock) return;
      clock = rising;
      if (!powered) return;
      if (rising) chip.rise(high(dio.read()) ? 1 : 0);
      else {
        if (chip.fall()) show();
        driveDio();
      }
    });
    dio.onChange((s) => {
      const level = high(s);
      if (level === data) return;
      data = level;
      if (!powered || !clock) return;
      // DIO moving while CLK is high: START (falling) or STOP (rising).
      if (level) chip.stop();
      else chip.start();
      driveDio();
    });
    vcc.onChange(checkPower);
    gnd.onChange(checkPower);
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
