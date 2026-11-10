import { Bench, NS_PER_MS, type ProjectDoc } from '@benchtop/core';
import { FakeMcu, type FakeStep, fakeBoard, makeBenchEnv, testDoc } from '@benchtop/core/testing';
import { describe, expect, it } from 'vitest';
import { relayModule } from '../actuators/relay-module.ts';
import { RELAY_OPERATE_NS, RELAY_RELEASE_NS } from '../actuators/relay-module.ts';
import { hc165 } from './hc165.ts';

// BT193: the 74HC165 on a bench with a scripted MCU — the function table, bit-banged chains in either
// placement order, read-only hardware SPI through the bench's chains — and the relay module.

const PINS = ['D2', 'D3', 'D4', 'D5', 'D7', 'D10', 'D11', 'D12', 'D13'];
const board = fakeBoard('fake-uno', PINS);
const US = 16;

function bench(doc: ProjectDoc, script: readonly FakeStep[], spi = false) {
  const mcu = new FakeMcu({ pins: PINS, script, spi: spi ? [{ sck: 'D13', mosi: 'D11', miso: 'D12' }] : [] });
  return { mcu, bench: new Bench(doc, makeBenchEnv([board, hc165, relayModule], () => mcu)) };
}

/** D0–D7 of a 165 tied to the rails as `byte`'s bits. */
function inputs(id: string, byte: number): [string, string][] {
  const out: [string, string][] = [];
  for (let n = 0; n < 8; n++) out.push([`${id}:D${n}`, (byte >> n) & 1 ? 'uno:5V' : 'uno:GND']);
  return out;
}

const power = (id: string): [string, string][] => [
  [`${id}:VCC`, 'uno:5V'],
  [`${id}:GND`, 'uno:GND'],
];

/** Q7 read before each of `bits` clocks (PL on D2, CP on D3; Q7 on D4 is sampled by the test). */
function readSteps(start: number, bits: number): { steps: FakeStep[]; samples: number[] } {
  const steps: FakeStep[] = [
    { cycle: start, pin: 'D2', mode: 'output', level: 0 }, // load
    { cycle: start + US, pin: 'D2', mode: 'output', level: 1 },
  ];
  const samples: number[] = [];
  let cycle = start + 2 * US;
  for (let i = 0; i < bits; i++) {
    samples.push(cycle + US / 2);
    steps.push({ cycle: cycle + US, pin: 'D3', mode: 'output', level: 1 });
    steps.push({ cycle: cycle + 2 * US, pin: 'D3', mode: 'output', level: 0 });
    cycle += 3 * US;
  }
  return { steps, samples };
}

const START: FakeStep[] = [
  { cycle: US, pin: 'D2', mode: 'output', level: 1 },
  { cycle: US, pin: 'D3', mode: 'output', level: 0 },
  { cycle: US, pin: 'D5', mode: 'output', level: 0 }, // CE low
];

function sampleBits(b: Bench, part: string, samples: readonly number[]): number {
  let v = 0;
  for (const cycle of samples) {
    b.runUntil((cycle / 16) * 1000);
    v = (v << 1) | (b.pinState(part, 'Q7')?.level ?? 0);
  }
  return v;
}

describe('74HC165 (BT193)', () => {
  it('loads D0–D7 while PL is low and shifts them out D7 first; CE high holds the clock; Q7N is the complement', () => {
    const read = readSteps(2 * US, 8);
    const doc = testDoc({ uno: 'fake-uno', sr: '74hc165' }, [['uno:D2', 'sr:PL'], ['uno:D3', 'sr:CP'], ['uno:D5', 'sr:CE'], ['sr:DS', 'uno:GND'], ...inputs('sr', 0b1100_1010), ...power('sr')]);
    const { bench: b } = bench(doc, [...START, ...read.steps]);
    expect(sampleBits(b, 'sr', read.samples)).toBe(0b1100_1010);
    b.runUntil(NS_PER_MS);
    expect(b.pinState('sr', 'Q7')?.level).toBe(0); // DS (GND) shifted all the way through
    expect(b.pinState('sr', 'Q7N')?.level).toBe(1);
    // CE high: clocks do nothing.
    const held = readSteps(20_000, 0);
    const { bench: c } = bench(doc, [
      ...START,
      ...held.steps,
      { cycle: 20_100, pin: 'D5', mode: 'output', level: 1 },
      { cycle: 20_200, pin: 'D3', mode: 'output', level: 1 },
      { cycle: 20_300, pin: 'D3', mode: 'output', level: 0 },
    ]);
    c.runUntil(2 * NS_PER_MS);
    expect(c.pinState('sr', 'Q7')?.level).toBe(1); // still D7
  });

  it.each([
    ['near', 'far'],
    ['far', 'near'],
  ])('chains bit-banged — the far 165’s Q7 into the near one’s DS — whatever the placement (%s, %s)', (...order) => {
    const read = readSteps(2 * US, 16);
    const wires: [string, string][] = [['far:Q7', 'near:DS'], ['far:DS', 'uno:GND'], ...inputs('near', 0x5a), ...inputs('far', 0xc3)];
    for (const id of ['near', 'far']) wires.push([`${id}:PL`, 'uno:D2'], [`${id}:CP`, 'uno:D3'], [`${id}:CE`, 'uno:D5'], ...power(id));
    const parts: Record<string, string> = { uno: 'fake-uno' };
    for (const id of order) parts[id] = '74hc165';
    const { bench: b } = bench(testDoc(parts, wires), [...START, ...read.steps]);
    expect(sampleBits(b, 'near', read.samples)).toBe(0x5ac3);
  });

  it('reads over hardware SPI as a read-only device, chained (DS on a rail at the far end)', () => {
    const wires: [string, string][] = [
      ['uno:D13', 'near:CP'],
      ['uno:D12', 'near:Q7'],
      ['far:Q7', 'near:DS'],
      ['uno:D13', 'far:CP'],
      ['far:DS', 'uno:GND'],
      ...inputs('near', 0x81),
      ...inputs('far', 0x3c),
    ];
    for (const id of ['near', 'far']) wires.push([`${id}:PL`, 'uno:D2'], [`${id}:CE`, 'uno:D10'], ...power(id));
    const script: FakeStep[] = [
      { cycle: US, pin: 'D10', mode: 'output', level: 1 },
      { cycle: US, pin: 'D2', mode: 'output', level: 0 },
      { cycle: 2 * US, pin: 'D2', mode: 'output', level: 1 },
      { cycle: 3 * US, pin: 'D10', mode: 'output', level: 0 },
    ];
    const { bench: b, mcu } = bench(testDoc({ uno: 'fake-uno', near: '74hc165', far: '74hc165' }, wires), script, true);
    b.runUntil(NS_PER_MS);
    const bus = mcu.spiControllers[0].attached;
    expect(bus).toHaveLength(1);
    expect([bus[0].device.transfer(0), bus[0].device.transfer(0), bus[0].device.transfer(0xff)]).toEqual([0x81, 0x3c, 0x00]);
    expect(b.problems().filter((p) => p.code === 'spi-unattached')).toEqual([]);
  });
});

describe('relay module (BT193)', () => {
  const doc = (trigger: string): ProjectDoc =>
    testDoc(
      { uno: 'fake-uno', k: 'relay-module' },
      [
        ['uno:D7', 'k:IN'],
        ['k:VCC', 'uno:5V'],
        ['k:GND', 'uno:GND'],
        ['k:COM', 'uno:5V'],
      ],
      { k: { trigger } },
    );

  it('energizes on a low IN after its operate time and lets go after its release time; a floating IN is off', () => {
    const script: FakeStep[] = [
      { cycle: 16_000, pin: 'D7', mode: 'output', level: 0 }, // 1 ms: on
      { cycle: 320_000, pin: 'D7', mode: 'input', level: 0 }, // 20 ms: floating
    ];
    const { bench: b } = bench(doc('low'), script);
    b.runUntil(0.5 * NS_PER_MS);
    expect(b.pinState('k', 'IN')?.level).toBe(1); // the board's pull-up
    expect(b.pinState('k', 'NC')?.level).toBe(1); // COM on NC at rest
    expect(b.pinState('k', 'NO')?.level).toBeNull();
    b.runUntil(NS_PER_MS + RELAY_OPERATE_NS - 1000);
    expect(b.pinState('k', 'NO')?.level).toBeNull();
    // IN fell inside the MCU's run: the timer fires at that run's end, up to a quantum (1 ms) late.
    b.runUntil(2 * NS_PER_MS + RELAY_OPERATE_NS);
    expect(b.pinState('k', 'NO')?.level).toBe(1);
    expect(b.pinState('k', 'NC')?.level).toBeNull();
    b.runUntil(20 * NS_PER_MS + RELAY_RELEASE_NS - 1000);
    expect(b.pinState('k', 'NO')?.level).toBe(1);
    b.runUntil(21 * NS_PER_MS + RELAY_RELEASE_NS);
    expect(b.pinState('k', 'NO')?.level).toBeNull();
    expect(b.pinState('k', 'NC')?.level).toBe(1);
  });

  it('never closes for an IN pulse shorter than the operate time', () => {
    const { bench: b } = bench(doc('low'), [
      { cycle: 16_000, pin: 'D7', mode: 'output', level: 0 },
      { cycle: 16_000 + 5 * 16_000, pin: 'D7', mode: 'output', level: 1 }, // 5 ms
    ]);
    for (let ms = 1; ms <= 30; ms++) {
      b.runUntil(ms * NS_PER_MS);
      expect(b.pinState('k', 'NO')?.level, `${ms} ms`).toBeNull();
    }
  });

  it('with the jumper on high, energizes on a high IN', () => {
    const { bench: b } = bench(doc('high'), [{ cycle: 16_000, pin: 'D7', mode: 'output', level: 1 }]);
    b.runUntil(20 * NS_PER_MS);
    expect(b.pinState('k', 'NO')?.level).toBe(1);
  });
});
