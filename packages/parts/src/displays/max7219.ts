/**
 * BT185: the MAX7219 LED driver (Maxim's MAX7219/MAX7221 datasheet) and three modules built on
 * it — `max7219-matrix` (one 8×8 red matrix), `max7219-matrix-4` (the FC-16 4-in-1: four chips
 * chained on one board) and `max7219-7seg-8` (eight 7-segment digits).
 *
 * The chip: DIN is shifted into a 16-bit register on every CLK rising edge whatever LOAD is (the
 * MAX7219's rule; the MAX7221 needs CS low), the last 16 bits are latched on LOAD's rising edge
 * (D11–D8 the register, D7–D0 the data, Table 1), and what was shifted in comes out of DOUT on the
 * falling edge, sixteen clocks behind, for the next chip. Registers (Table 2): no-op, digits 0–7,
 * decode mode (a 1 bit decodes that digit's low nibble with the Code B font — 0–9, -, E, H, L, P,
 * blank — D7 its decimal point), intensity ((2k + 1)/32 duty), scan limit (digits 0…k scanned),
 * shutdown (0 blanks the display, registers kept) and display test (1 lights everything, overriding
 * but not changing the rest). At power-up every control register is 0 — shutdown, one digit, no
 * decode, minimum intensity — and the display is blank. No-decode segment bits (Table 6): D7 DP,
 * D6 A, D5 B, D4 C, D3 D, D2 E, D1 F, D0 G. Powered means V+ at 4 V or more over GND (its minimum).
 *
 * A module's chips are chained inside it; chip 0 is the one DIN reaches first. Bit-banged bytes
 * arrive as pin edges, hardware SPI bytes through `attachSpi` with GND as the select (it shifts
 * whatever its clock brings): a byte moves each chip's register on by eight bits, the next chip
 * gets the byte that fell out, and the last one's is what the module shifts out on DOUT — to the
 * next module of a bench-level chain. Wiring the modules' pixels (MD_MAX72XX's FC16_HW: digits are
 * rows, no reversals): digit d is row d from the top, D7 the leftmost column, and chip 0 is the
 * rightmost matrix — data enters on the right, where the input header is. On the 7-segment module
 * digit 0 is the rightmost.
 *
 * Visual: `rows` (eight bytes per chip, chip 0 first: what each digit shows now — blank in shutdown,
 * 0xFF in display test, past the scan limit dark), `level` (per chip, its light relative to full
 * intensity on all eight digits: the duty times 8 / scanned digits, at most 1 — fewer scanned digits
 * are brighter, as the datasheet warns), and for the 7-segment module `values` and `segments` as the
 * 7-segment parts give them (left to right), so the text readers see a dim digit as lit.
 */

import { type NetState, type PartContext, type PinDef, type SpiDevice, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';

/** V+ over GND at or above this powers the chip (the datasheet's 4.0 V minimum). */
export const MAX7219_MIN_VOLTS = 4;

/** Code B (Table 5) as no-decode segment bits (D6 A … D0 G): 0–9, -, E, H, L, P, blank. */
export const CODE_B = [0x7e, 0x30, 0x6d, 0x79, 0x33, 0x5b, 0x5f, 0x70, 0x7f, 0x7b, 0x01, 0x4f, 0x37, 0x0e, 0x67, 0x00] as const;

/** One MAX7219: its shift register and registers. */
export class Max7219 {
  /** The 16-bit shift register. */
  shift = 0;
  readonly digits = new Uint8Array(8);
  decode = 0;
  intensity = 0;
  scanLimit = 0;
  /** Shutdown register D0 = 0: blank. */
  shutdown = true;
  test = false;

  powerOn(): void {
    this.shift = 0;
    this.digits.fill(0);
    this.decode = 0;
    this.intensity = 0;
    this.scanLimit = 0;
    this.shutdown = true;
    this.test = false;
  }

  /** The bit DOUT shows: the shift register's D15. */
  get out(): number {
    return (this.shift >> 15) & 1;
  }

  /** One CLK rising edge with `bit` on DIN. */
  clockIn(bit: number): void {
    this.shift = ((this.shift << 1) | bit) & 0xffff;
  }

  /** Eight clocks of `byte` (MSB first); returns the byte that came out of DOUT. */
  transfer(byte: number): number {
    const out = (this.shift >> 8) & 0xff;
    this.shift = ((this.shift << 8) | (byte & 0xff)) & 0xffff;
    return out;
  }

  /** LOAD ↑: the last 16 bits go to their register. */
  latch(): void {
    const address = (this.shift >> 8) & 0x0f;
    const data = this.shift & 0xff;
    if (address >= 1 && address <= 8) this.digits[address - 1] = data;
    else if (address === 0x9) this.decode = data;
    else if (address === 0xa) this.intensity = data & 0x0f;
    else if (address === 0xb) this.scanLimit = data & 0x07;
    else if (address === 0xc) this.shutdown = (data & 1) === 0;
    else if (address === 0xf) this.test = (data & 1) === 1;
  }

  /** What digit `d` shows now, as no-decode segment bits (D7 DP, D6 A … D0 G). */
  shown(d: number): number {
    if (this.test) return 0xff;
    if (this.shutdown || d > this.scanLimit) return 0;
    const data = this.digits[d];
    return (this.decode >> d) & 1 ? CODE_B[data & 0x0f] | (data & 0x80) : data;
  }

  /** Light relative to full intensity on eight scanned digits (display test: 31/32 on all eight). */
  get level(): number {
    if (this.test) return 31 / 32;
    if (this.shutdown) return 0;
    return Math.min(1, (((2 * this.intensity + 1) / 32) * 8) / (this.scanLimit + 1));
  }
}

/** No-decode segment bits → the 7-segment parts' order (bit 0 A … bit 6 G, bit 7 DP). */
export function segmentBits(shown: number): number {
  let bits = (shown >> 7) << 7;
  for (let s = 0; s < 7; s++) if ((shown >> (6 - s)) & 1) bits |= 1 << s;
  return bits;
}

/**
 * BT189: a matrix module's dots as text, a string per row from the top, left to right ('#' lit,
 * '.' dark) — chip 0 is the rightmost matrix, D7 a matrix's leftmost column.
 */
export function matrixText(rows: readonly number[]): string[] {
  const count = Math.max(1, Math.floor(rows.length / 8));
  const out: string[] = [];
  for (let r = 0; r < 8; r++) {
    let line = '';
    for (let chip = count - 1; chip >= 0; chip--) {
      const byte = rows[chip * 8 + r] ?? 0;
      for (let c = 7; c >= 0; c--) line += (byte >> c) & 1 ? '#' : '.';
    }
    out.push(line);
  }
  return out;
}

const high = (s: NetState): boolean => s.level === 1;

/** The 5-pin headers: the input on the right, the output (DOUT) on the left, as on the boards. */
function modulePins(w: number, h: number): PinDef[] {
  const names = ['VCC', 'GND', 'DIN', 'CS', 'CLK'] as const;
  const top = h / 2 - 2 * 2.54;
  const pins: PinDef[] = [];
  names.forEach((name, i) => pins.push({ name, x: w - 1.27, y: top + i * 2.54, role: name === 'VCC' ? 'power' : name === 'GND' ? 'ground' : 'digital' }));
  names.forEach((name, i) => {
    const out = name === 'DIN' ? 'DOUT' : `${name}.2`;
    pins.push({ name: out, x: 1.27, y: top + i * 2.54, role: name === 'VCC' ? 'power' : name === 'GND' ? 'ground' : 'digital' });
  });
  return pins;
}

/** The input and output headers' VCC, GND, CS and CLK are the same nets on the board. */
const MODULE_BUSES = [
  ['VCC', 'VCC.2'],
  ['GND', 'GND.2'],
  ['CS', 'CS.2'],
  ['CLK', 'CLK.2'],
] as const;

/** A module of `count` chained chips; `sevenSegment` adds the 7-segment parts' visual. */
function moduleModel(ctx: PartContext, count: number, sevenSegment: boolean) {
  const chips = Array.from({ length: count }, () => new Max7219());
  const din = ctx.pin('DIN');
  const clk = ctx.pin('CLK');
  const load = ctx.pin('CS');
  const dout = ctx.pin('DOUT');
  const vcc = ctx.pin('VCC');
  const gnd = ctx.pin('GND');
  const last = chips[count - 1];
  const rows: number[] = new Array<number>(count * 8).fill(0);
  const level: number[] = new Array<number>(count).fill(0);
  const values: number[] = new Array<number>(sevenSegment ? 64 : 0).fill(0);
  const segments: number[] = new Array<number>(sevenSegment ? 8 : 0).fill(0);
  const visual = sevenSegment ? { rows, level, values, segments } : { rows, level };
  let powered = false;
  let clock = false;
  let loading = false;
  let driven = -1;

  const show = (): void => {
    for (let c = 0; c < count; c++) {
      const chip = chips[c];
      level[c] = powered ? chip.level : 0;
      for (let d = 0; d < 8; d++) rows[c * 8 + d] = powered ? chip.shown(d) : 0;
    }
    if (sevenSegment) {
      // Digit 0 is the rightmost: the visual runs left to right.
      for (let d = 0; d < 8; d++) {
        const bits = segmentBits(rows[d]);
        const at = 7 - d;
        segments[at] = bits;
        for (let s = 0; s < 8; s++) values[at * 8 + s] = (bits >> s) & 1 ? level[0] : 0;
      }
    }
    ctx.invalidate();
  };
  const driveOut = (): void => {
    const bit = powered ? last.out : -1;
    if (bit === driven) return;
    driven = bit;
    if (bit < 0) dout.release();
    else if (bit === 1) dout.driveVolts(vcc.read().volts, Strength.strong);
    else dout.drive(0, Strength.strong);
  };
  const checkPower = (): void => {
    const v = vcc.read();
    const g = gnd.read();
    const on = v.level === 1 && g.level === 0 && v.volts - g.volts >= MAX7219_MIN_VOLTS;
    if (on === powered) return;
    powered = on;
    for (const chip of chips) chip.powerOn();
    clock = high(clk.read());
    loading = high(load.read());
    driven = -2;
    driveOut();
    show();
  };

  clk.onChange((s) => {
    const rising = high(s);
    if (rising === clock) return;
    clock = rising;
    if (!powered) return;
    if (rising) {
      // Every chip shifts at once: each takes the D15 its neighbour showed before this edge.
      for (let c = count - 1; c > 0; c--) chips[c].clockIn(chips[c - 1].out);
      chips[0].clockIn(high(din.read()) ? 1 : 0);
    } else driveOut();
  });
  load.onChange((s) => {
    const rising = high(s);
    if (rising === loading) return;
    loading = rising;
    if (!powered || !rising) return;
    for (const chip of chips) chip.latch();
    show();
  });
  vcc.onChange(checkPower);
  gnd.onChange(checkPower);

  const device: SpiDevice = {
    transfer(mosi: number): number {
      if (!powered) return 0xff;
      let byte = mosi & 0xff;
      for (let c = 0; c < count; c++) byte = chips[c].transfer(byte);
      driveOut();
      return byte;
    },
  };
  ctx.attachSpi({ sck: 'CLK', mosi: 'DIN', miso: 'DOUT', cs: 'GND' }, device);
  checkPower();

  return {
    reset() {
      powered = false;
      checkPower();
    },
    visual: () => visual,
  };
}

const MATRIX = 33.02;

export const max7219Matrix = definePart({
  type: 'max7219-matrix',
  title: 'MAX7219 8×8 LED matrix',
  category: 'displays',
  size: { w: MATRIX, h: MATRIX },
  pins: modulePins(MATRIX, MATRIX),
  buses: MODULE_BUSES,
  defaults: {},
  createModel: (ctx) => moduleModel(ctx, 1, false),
});

export const max7219Matrix4 = definePart({
  type: 'max7219-matrix-4',
  title: 'MAX7219 4-in-1 LED matrix (FC-16)',
  category: 'displays',
  size: { w: 4 * 32 + 1.54, h: MATRIX },
  pins: modulePins(4 * 32 + 1.54, MATRIX),
  buses: MODULE_BUSES,
  defaults: {},
  createModel: (ctx) => moduleModel(ctx, 4, false),
});

const SEVEN_W = 83.82;
const SEVEN_H = 15.24;

export const max72197Seg8 = definePart({
  type: 'max7219-7seg-8',
  title: 'MAX7219 8-digit 7-segment display',
  category: 'displays',
  size: { w: SEVEN_W, h: SEVEN_H },
  pins: modulePins(SEVEN_W, SEVEN_H),
  buses: MODULE_BUSES,
  defaults: {},
  createModel: (ctx) => moduleModel(ctx, 1, true),
});

/** The MAX7219 parts. */
export const MAX7219_TYPES: ReadonlySet<string> = new Set(['max7219-matrix', 'max7219-matrix-4', 'max7219-7seg-8']);
