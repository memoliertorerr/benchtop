import { Bench, NS_PER_MS, type ProjectDoc } from '@benchtop/core';
import { FakeMcu, type FakeStep, fakeBoard, makeBenchEnv, testDoc } from '@benchtop/core/testing';
import { describe, expect, it } from 'vitest';
import { CODE_B, Max7219, max7219Matrix, max7219Matrix4, max72197Seg8, segmentBits } from './max7219.ts';
import { sevenSegmentText } from './seven-segment.ts';

// BT185: the MAX7219 against the datasheet's tables, and its modules on a bench with a scripted
// MCU — bit-banged words through two chained modules, hardware SPI into the FC-16 and on.

const word = (address: number, data: number): number => ((address & 0x0f) << 8) | (data & 0xff);

function chipWith(...words: number[]): Max7219 {
  const chip = new Max7219();
  for (const w of words) {
    chip.transfer(w >> 8);
    chip.transfer(w & 0xff);
    chip.latch();
  }
  return chip;
}

describe('the MAX7219 chip (BT185)', () => {
  it('powers up in shutdown, one digit, no decode, minimum intensity, blank', () => {
    const chip = new Max7219();
    expect([chip.shutdown, chip.scanLimit, chip.decode, chip.intensity, chip.test]).toEqual([true, 0, 0, 0, false]);
    chip.digits[0] = 0xff;
    expect(chip.shown(0)).toBe(0); // shutdown blanks it
    expect(chip.level).toBe(0);
  });

  it('latches the last 16 bits into the register D11–D8 names; D15–D12 are ignored', () => {
    const chip = chipWith(0xf000 | word(0x3, 0x5a), word(0xc, 1), word(0xb, 7));
    expect(chip.digits[2]).toBe(0x5a);
    expect(chip.shown(2)).toBe(0x5a);
    chipWith(word(0x0, 0x12)); // a no-op changes nothing
    const noop = chipWith(word(0x1, 0x77), word(0x0, 0x12));
    expect(noop.digits[0]).toBe(0x77);
  });

  it('decodes Code B per digit (Table 5), D7 the decimal point', () => {
    const chip = chipWith(word(0xc, 1), word(0xb, 7), word(0x9, 0x0f));
    const shown: number[] = [];
    for (let code = 0; code < 16; code++) {
      chip.digits[0] = code;
      shown.push(chip.shown(0));
    }
    expect(shown).toEqual([...CODE_B]);
    chip.digits[0] = 0x80 | 7;
    expect(chip.shown(0)).toBe(0x80 | 0x70);
    chip.digits[4] = 7; // digit 4 isn't decoded: raw segments G, F, E
    expect(chip.shown(4)).toBe(7);
    expect(segmentBits(0x7e)).toBe(0x3f); // "0": A–F
    expect(segmentBits(0x80 | 0x30)).toBe(0x86); // "1.": B, C and DP
  });

  it('scans digits 0…limit, display test lights all over shutdown, intensity sets the duty (Table 7)', () => {
    const chip = chipWith(word(0xc, 1), word(0xb, 3), word(0xa, 0x0f));
    chip.digits.fill(0x81);
    expect([0, 1, 2, 3, 4, 7].map((d) => chip.shown(d))).toEqual([0x81, 0x81, 0x81, 0x81, 0, 0]);
    expect(chip.level).toBe(1); // 31/32 × 8/4, at most 1
    const dim = chipWith(word(0xc, 1), word(0xb, 7), word(0xa, 0));
    expect(dim.level).toBeCloseTo(1 / 32, 9);
    expect(chipWith(word(0xc, 1), word(0xb, 7), word(0xa, 8)).level).toBeCloseTo(17 / 32, 9);
    const test = chipWith(word(0xf, 1));
    expect([test.shown(0), test.shown(7), test.level]).toEqual([0xff, 0xff, 31 / 32]);
    test.transfer(0x0f);
    test.transfer(0x00);
    test.latch();
    expect(test.shown(0)).toBe(0); // back to shutdown, as it was
  });
});

const PINS = ['D2', 'D3', 'D4', 'D10', 'D11', 'D12', 'D13'];
const board = { ...fakeBoard('fake-uno', PINS) };
const US = 16;

function bench(doc: ProjectDoc, script: readonly FakeStep[], spi = false) {
  const mcu = new FakeMcu({ pins: PINS, script, spi: spi ? [{ sck: 'D13', mosi: 'D11', miso: 'D12' }] : [] });
  return { mcu, bench: new Bench(doc, makeBenchEnv([board, max7219Matrix, max7219Matrix4, max72197Seg8], () => mcu)) };
}

/** Bit-banged words (MSB first) on DIN = D2, CLK = D3, then a LOAD (D4) pulse, LedControl's way. */
function words(list: readonly (readonly number[])[], start: number): { steps: FakeStep[]; next: number } {
  const steps: FakeStep[] = [];
  let cycle = start;
  for (const frame of list) {
    steps.push({ cycle, pin: 'D4', mode: 'output', level: 0 });
    cycle += US;
    for (const w of frame) {
      for (let bit = 15; bit >= 0; bit--) {
        steps.push({ cycle, pin: 'D2', mode: 'output', level: ((w >> bit) & 1) as 0 | 1 });
        steps.push({ cycle: cycle + US, pin: 'D3', mode: 'output', level: 1 });
        steps.push({ cycle: cycle + 2 * US, pin: 'D3', mode: 'output', level: 0 });
        cycle += 3 * US;
      }
    }
    steps.push({ cycle, pin: 'D4', mode: 'output', level: 1 });
    cycle += 2 * US;
  }
  return { steps, next: cycle };
}

const START: FakeStep[] = [
  { cycle: US, pin: 'D2', mode: 'output', level: 0 },
  { cycle: US, pin: 'D3', mode: 'output', level: 0 },
  { cycle: US, pin: 'D4', mode: 'output', level: 1 },
];

function visuals(b: Bench): Map<string, Record<string, unknown>> {
  return new Map([...b.collectFrame().parts].map(([id, v]) => [id, v as Record<string, unknown>]));
}

const power = (id: string): [string, string][] => [
  [`${id}:VCC`, 'uno:5V'],
  [`${id}:GND`, 'uno:GND'],
];

describe('MAX7219 modules on a bench (BT185)', () => {
  it.each([
    ['near', 'far'],
    ['far', 'near'],
  ])('chain bit-banged through DOUT → DIN, a word apiece per LOAD (placed %s, %s)', (...order) => {
    // Each frame: the far module's word first, then the near one's.
    const setup = [word(0xc, 1), word(0xb, 7), word(0xa, 0x0f)].map((w) => [w, w]);
    const rows: number[][] = [];
    for (let r = 0; r < 8; r++) rows.push([word(r + 1, 0x80 >> r), word(r + 1, 1 << r)]);
    const sent = words([...setup, ...rows], 2 * US);
    const wires: [string, string][] = [
      ['uno:D2', 'near:DIN'],
      ['uno:D3', 'near:CLK'],
      ['uno:D4', 'near:CS'],
      ['near:DOUT', 'far:DIN'],
      ['near:CLK.2', 'far:CLK'],
      ['near:CS.2', 'far:CS'],
      ...power('near'),
      ['near:VCC.2', 'far:VCC'],
      ['near:GND.2', 'far:GND'],
    ];
    const parts: Record<string, string> = { uno: 'fake-uno' };
    for (const id of order) parts[id] = 'max7219-matrix';
    const { bench: b } = bench(testDoc(parts, wires), [...START, ...sent.steps]);
    b.runUntil(5 * NS_PER_MS);
    const v = visuals(b);
    expect(v.get('near')?.rows).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
    expect(v.get('far')?.rows).toEqual([128, 64, 32, 16, 8, 4, 2, 1]);
    expect(v.get('near')?.level).toEqual([31 / 32]); // intensity 15 on eight digits
  });

  it('take hardware SPI: the FC-16’s four chips, and a module chained after it', () => {
    const wires: [string, string][] = [
      ['uno:D13', 'fc:CLK'],
      ['uno:D11', 'fc:DIN'],
      ['uno:D10', 'fc:CS'],
      ['fc:DOUT', 'one:DIN'],
      ['fc:CLK.2', 'one:CLK'],
      ['fc:CS.2', 'one:CS'],
      ...power('fc'),
      ...power('one'),
    ];
    const latchAt = (ms: number): FakeStep[] => [
      { cycle: ms * 1000 * US, pin: 'D10', mode: 'output', level: 0 },
      { cycle: (ms * 1000 + 5) * US, pin: 'D10', mode: 'output', level: 1 },
    ];
    const script: FakeStep[] = [{ cycle: US, pin: 'D10', mode: 'output', level: 1 }, ...[2, 4, 6, 8].flatMap(latchAt)];
    const { bench: b, mcu } = bench(testDoc({ uno: 'fake-uno', one: 'max7219-matrix', fc: 'max7219-matrix-4' }, wires), script, true);
    const bus = mcu.spiControllers[0].attached;
    expect(bus).toHaveLength(1);
    // Five chips: the first word sent ends in the far module, the last in the FC-16's chip 0.
    const send = (frame: readonly number[]): void => {
      for (const w of frame) {
        bus[0].device.transfer(w >> 8);
        bus[0].device.transfer(w & 0xff);
      }
    };
    b.runUntil(NS_PER_MS);
    send(Array(5).fill(word(0xc, 1)));
    b.runUntil(3 * NS_PER_MS);
    send(Array(5).fill(word(0xb, 7)));
    b.runUntil(5 * NS_PER_MS);
    send([word(1, 0xee), word(1, 0x04), word(1, 0x03), word(1, 0x02), word(1, 0x01)]);
    b.runUntil(7 * NS_PER_MS);
    const v = visuals(b);
    expect((v.get('one')?.rows as number[])[0]).toBe(0xee);
    expect((v.get('fc')?.rows as number[]).filter((_, i) => i % 8 === 0)).toEqual([0x01, 0x02, 0x03, 0x04]);
    expect(b.problems().filter((p) => p.code === 'spi-unattached')).toEqual([]);
  });

  it('show the 8-digit module’s digits left to right, the rightmost digit 0', () => {
    const setup = [word(0xc, 1), word(0xb, 7), word(0xa, 8), word(0x9, 0xff)];
    const digits = [0x81, 0x00, 0x0e, 0x0d, 0x0b, 0x0c, 0x0a, 0x0f].map((code, d) => word(d + 1, code)); // " -HELP01." from the left
    const sent = words([...setup, ...digits].map((w) => [w]), 2 * US);
    const wires: [string, string][] = [['uno:D2', 'seg:DIN'], ['uno:D3', 'seg:CLK'], ['uno:D4', 'seg:CS'], ...power('seg')];
    const { bench: b } = bench(testDoc({ uno: 'fake-uno', seg: 'max7219-7seg-8' }, wires), [...START, ...sent.steps]);
    b.runUntil(5 * NS_PER_MS);
    const v = visuals(b).get('seg') ?? {};
    expect(sevenSegmentText(v.values as number[])).toBe(' -HELP01');
    expect((v.segments as number[])[7]).toBe(0x86); // "1." — B, C and the point
    expect((v.values as number[])[7 * 8 + 1]).toBeCloseTo(17 / 32, 9);
  });

  it('stays dark unpowered or below 4 V, and releases DOUT', () => {
    const sent = words([[word(0xf, 1)]], 2 * US);
    const { bench: b } = bench(
      testDoc({ uno: 'fake-uno', m: 'max7219-matrix' }, [
        ['uno:D2', 'm:DIN'],
        ['uno:D3', 'm:CLK'],
        ['uno:D4', 'm:CS'],
        ['m:GND', 'uno:GND'],
      ]),
      [...START, ...sent.steps],
    );
    b.runUntil(2 * NS_PER_MS);
    expect(visuals(b).get('m')?.rows ?? [0, 0, 0, 0, 0, 0, 0, 0]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(b.pinState('m', 'DOUT')?.level).toBeNull();
  });
});
