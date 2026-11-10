import { Bench, NS_PER_MS, type PartDefinition, type ProjectDoc } from '@benchtop/core';
import { FakeMcu, type FakeStep, fakeBoard, makeBenchEnv, testDoc } from '@benchtop/core/testing';
import { describe, expect, it } from 'vitest';
import { hc595 } from './hc595.ts';

// BT184: the 74HC595 on a bench with a scripted MCU — the function table, bit-banged chains in
// either placement order, and hardware SPI through the bench's buses and chains.

const PINS = ['D2', 'D3', 'D4', 'D5', 'D6', 'D9', 'D10', 'D11', 'D12', 'D13'];
const board = fakeBoard('fake-uno', PINS);
const US = 16; // cycles at 16 MHz

/** A responder on the SPI bus: selected by its CS, on MISO, it answers each byte inverted. */
const responder: PartDefinition = {
  type: 'responder',
  title: 'Responder',
  category: 'ics',
  size: { w: 10, h: 5 },
  pins: ['SCK', 'DI', 'DO', 'CS'].map((name, i) => ({ name, x: i * 2.54, y: 0, role: 'digital' as const })),
  defaults: {},
  createModel(ctx) {
    ctx.attachSpi({ sck: 'SCK', mosi: 'DI', miso: 'DO', cs: 'CS' }, { transfer: (b) => b ^ 0xff });
    return {};
  },
};

function bench(doc: ProjectDoc, script: readonly FakeStep[], spi = false) {
  const mcu = new FakeMcu({ pins: PINS, script, spi: spi ? [{ sck: 'D13', mosi: 'D11', miso: 'D12' }] : [] });
  return { mcu, bench: new Bench(doc, makeBenchEnv([board, hc595, responder], () => mcu)) };
}

/** Wires a 595's power, and its MR and OE to the given pins or rails. */
function powered(id: string, mr = 'uno:5V', oe = 'uno:GND'): [string, string][] {
  return [
    [`${id}:VCC`, 'uno:5V'],
    [`${id}:GND`, 'uno:GND'],
    [`${id}:MR`, mr],
    [`${id}:OE`, oe],
  ];
}

/** shiftOut(MSBFIRST) of each byte on DS = D2, SHCP = D3, from `cycle`, 4 µs a bit; returns the steps and the next cycle. */
function shiftOut(bytes: readonly number[], cycle: number): { steps: FakeStep[]; next: number } {
  const steps: FakeStep[] = [];
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      steps.push({ cycle, pin: 'D2', mode: 'output', level: ((byte >> bit) & 1) as 0 | 1 });
      steps.push({ cycle: cycle + US, pin: 'D3', mode: 'output', level: 1 });
      steps.push({ cycle: cycle + 2 * US, pin: 'D3', mode: 'output', level: 0 });
      cycle += 4 * US;
    }
  }
  return { steps, next: cycle };
}

/** A latch pulse on STCP = D4. */
const latch = (cycle: number): FakeStep[] => [
  { cycle, pin: 'D4', mode: 'output', level: 1 },
  { cycle: cycle + US, pin: 'D4', mode: 'output', level: 0 },
];

const START: FakeStep[] = [
  { cycle: US, pin: 'D2', mode: 'output', level: 0 },
  { cycle: US, pin: 'D3', mode: 'output', level: 0 },
  { cycle: US, pin: 'D4', mode: 'output', level: 0 },
];

/** Q0–Q7 as a byte; null when any output is released. */
function outputs(b: Bench, id: string): number | null {
  let q = 0;
  for (let n = 0; n < 8; n++) {
    const s = b.pinState(id, `Q${n}`);
    if (s === undefined || s.level === null) return null;
    q |= s.level << n;
  }
  return q;
}

describe('74HC595 (BT184)', () => {
  it('follows the function table: shift on SHCP ↑, latch on STCP ↑, MR clears, OE releases', () => {
    const shifted = shiftOut([0b1010_0011], 2 * US);
    const script: FakeStep[] = [
      ...START,
      { cycle: US, pin: 'D5', mode: 'output', level: 1 }, // MR high
      { cycle: US, pin: 'D6', mode: 'output', level: 0 }, // OE low
      ...shifted.steps,
      ...latch(shifted.next),
      { cycle: 1_000 * US, pin: 'D6', mode: 'output', level: 1 }, // OE high at 1 ms
      { cycle: 2_000 * US, pin: 'D6', mode: 'output', level: 0 }, // OE low at 2 ms
      { cycle: 3_000 * US, pin: 'D5', mode: 'output', level: 0 }, // MR low at 3 ms…
      { cycle: 3_010 * US, pin: 'D5', mode: 'output', level: 1 },
      ...latch(3_100 * US), // …then a latch shows the cleared register
    ];
    const doc = testDoc({ uno: 'fake-uno', sr: '74hc595' }, [
      ['uno:D2', 'sr:DS'],
      ['uno:D3', 'sr:SHCP'],
      ['uno:D4', 'sr:STCP'],
      ...powered('sr', 'uno:D5', 'uno:D6'),
    ]);
    const { bench: b } = bench(doc, script);
    b.runUntil(0.5 * NS_PER_MS);
    expect(outputs(b, 'sr')).toBe(0b1010_0011);
    expect(b.pinState('sr', 'Q7S')?.level).toBe(1); // stage 7 = the first bit shifted in
    b.runUntil(1.5 * NS_PER_MS);
    expect(outputs(b, 'sr')).toBeNull();
    b.runUntil(2.5 * NS_PER_MS);
    expect(outputs(b, 'sr')).toBe(0b1010_0011); // the storage register kept it
    b.runUntil(3.05 * NS_PER_MS);
    expect(outputs(b, 'sr')).toBe(0b1010_0011); // MR clears the shift register only
    expect(b.pinState('sr', 'Q7S')?.level).toBe(0);
    b.runUntil(4 * NS_PER_MS);
    expect(outputs(b, 'sr')).toBe(0);
  });

  it('drives nothing unpowered, and a high output at its VCC', () => {
    const shifted = shiftOut([0xff], 2 * US);
    const script = [...START, ...shifted.steps, ...latch(shifted.next)];
    const wires: [string, string][] = [
      ['uno:D2', 'sr:DS'],
      ['uno:D3', 'sr:SHCP'],
      ['uno:D4', 'sr:STCP'],
    ];
    const off = bench(testDoc({ uno: 'fake-uno', sr: '74hc595' }, [...wires, ['sr:GND', 'uno:GND'], ['sr:MR', 'uno:5V'], ['sr:OE', 'uno:GND']]), script).bench;
    off.runUntil(NS_PER_MS);
    expect(outputs(off, 'sr')).toBeNull();
    const on = bench(testDoc({ uno: 'fake-uno', sr: '74hc595' }, [...wires, ...powered('sr')]), script).bench;
    on.runUntil(NS_PER_MS);
    expect(outputs(on, 'sr')).toBe(0xff);
    expect(on.pinState('sr', 'Q3')?.volts).toBe(5);
  });

  it.each([
    ['u1', 'u2', 'u3'],
    ['u3', 'u2', 'u1'],
    ['u2', 'u3', 'u1'],
  ])('chains bit-banged through Q7S → DS whatever the placement order (%s, %s, %s)', (...order) => {
    const shifted = shiftOut([0x12, 0x34, 0x56], 2 * US);
    const script = [...START, ...shifted.steps, ...latch(shifted.next)];
    const wires: [string, string][] = [
      ['uno:D2', 'u1:DS'],
      ['u1:Q7S', 'u2:DS'],
      ['u2:Q7S', 'u3:DS'],
    ];
    for (const id of ['u1', 'u2', 'u3']) wires.push([`${id}:SHCP`, 'uno:D3'], [`${id}:STCP`, 'uno:D4'], ...powered(id));
    const parts: Record<string, string> = { uno: 'fake-uno' };
    for (const id of order) parts[id] = '74hc595';
    const { bench: b } = bench(testDoc(parts, wires), script);
    b.runUntil(NS_PER_MS);
    expect([outputs(b, 'u1'), outputs(b, 'u2'), outputs(b, 'u3')]).toEqual([0x56, 0x34, 0x12]);
  });

  it('takes hardware SPI, alone or chained, and reads the chain back on MISO', () => {
    const script = [...START, { cycle: US, pin: 'D10', mode: 'output' as const, level: 0 as const }, ...latch(2_000 * US).map((s) => ({ ...s, pin: 'D10' }))];
    const wires: [string, string][] = [
      ['uno:D13', 'a:SHCP'],
      ['uno:D11', 'a:DS'],
      ['a:Q7S', 'b:DS'],
      ['uno:D13', 'b:SHCP'],
      ['b:Q7S', 'uno:D12'],
      ['a:STCP', 'uno:D10'],
      ['b:STCP', 'uno:D10'],
      ...powered('a'),
      ...powered('b'),
    ];
    const { bench: b, mcu } = bench(testDoc({ uno: 'fake-uno', b: '74hc595', a: '74hc595' }, wires), script, true);
    b.runUntil(NS_PER_MS);
    const bus = mcu.spiControllers[0].attached;
    expect(bus).toHaveLength(1);
    expect([0x12, 0x34, 0x56].map((byte) => bus[0].device.transfer(byte))).toEqual([0, 0, 0x12]);
    b.runUntil(3 * NS_PER_MS);
    expect([outputs(b, 'a'), outputs(b, 'b')]).toEqual([0x56, 0x34]);
    expect(b.problems().filter((p) => p.code === 'spi-unattached')).toEqual([]);
  });

  it('shares a bus with a selected device without answering for it', () => {
    const script = [...START, { cycle: US, pin: 'D9', mode: 'output' as const, level: 0 as const }, ...latch(2_000 * US).map((s) => ({ ...s, pin: 'D10' }))];
    const wires: [string, string][] = [
      ['uno:D13', 'sr:SHCP'],
      ['uno:D11', 'sr:DS'],
      ['sr:STCP', 'uno:D10'],
      ...powered('sr'),
      ['uno:D13', 'dev:SCK'],
      ['uno:D11', 'dev:DI'],
      ['uno:D12', 'dev:DO'],
      ['uno:D9', 'dev:CS'],
    ];
    const { bench: b, mcu } = bench(testDoc({ uno: 'fake-uno', sr: '74hc595', dev: 'responder' }, wires), script, true);
    b.runUntil(NS_PER_MS);
    const bus = mcu.spiControllers[0].attached;
    expect([0x0f, 0x5a].map((byte) => bus[0].device.transfer(byte))).toEqual([0xf0, 0xa5]); // the responder's answers
    b.runUntil(3 * NS_PER_MS);
    expect(outputs(b, 'sr')).toBe(0x5a); // and the 595 heard both
  });
});
