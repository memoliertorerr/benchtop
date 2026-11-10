import { Bench, NS_PER_MS, NS_PER_US, type ProjectDoc } from '@benchtop/core';
import { FakeMcu, type FakeStep, fakeBoard, makeBenchEnv, testDoc } from '@benchtop/core/testing';
import { describe, expect, it } from 'vitest';
import { sevenSegmentText } from './seven-segment.ts';
import { tm1637FourDigit } from './tm1637.ts';

// BT186: the TM1637 module on a bench with a scripted MCU that drives CLK (D2) and DIO (D3) as
// TM1637Display does — open drain: OUTPUT pulls low, INPUT lets the module's pull-up raise it.

const PINS = ['D2', 'D3'];
const board = fakeBoard('fake-uno', PINS);
const STEP = 160; // cycles: 10 µs at 16 MHz

/** TM1637Display's bus moves, one every 10 µs; `at` records when each ACK clock is high. */
class Driver {
  readonly steps: FakeStep[] = [];
  readonly acks: number[] = [];
  cycle = STEP;
  private pin(pin: 'D2' | 'D3', low: boolean): void {
    this.steps.push({ cycle: this.cycle, pin, mode: low ? 'output' : 'input', level: 0 });
    this.cycle += STEP;
  }
  start(): void {
    this.pin('D3', true);
  }
  stop(): void {
    this.pin('D3', true);
    this.pin('D2', false);
    this.pin('D3', false);
  }
  byte(b: number): void {
    for (let i = 0; i < 8; i++) {
      this.pin('D2', true);
      this.pin('D3', ((b >> i) & 1) === 0);
      this.pin('D2', false);
    }
    this.pin('D2', true);
    this.pin('D3', false);
    this.pin('D2', false);
    this.acks.push(this.cycle - STEP / 2); // CLK high: the ACK should be on DIO
    this.pin('D2', true);
  }
  /** The first `n` bits of a byte, and no more. */
  partial(b: number, n: number): void {
    for (let i = 0; i < n; i++) {
      this.pin('D2', true);
      this.pin('D3', ((b >> i) & 1) === 0);
      this.pin('D2', false);
    }
  }
  frame(...bytes: number[]): void {
    this.start();
    for (const b of bytes) this.byte(b);
    this.stop();
  }
}

function bench(doc: ProjectDoc, steps: readonly FakeStep[]) {
  const mcu = new FakeMcu({ pins: PINS, script: steps });
  return new Bench(doc, makeBenchEnv([board, tm1637FourDigit], () => mcu));
}

const wired = (vcc = 'uno:5V'): ProjectDoc =>
  testDoc({ uno: 'fake-uno', tm: 'tm1637-4digit' }, [
    ['uno:D2', 'tm:CLK'],
    ['uno:D3', 'tm:DIO'],
    ['tm:VCC', vcc],
    ['tm:GND', 'uno:GND'],
  ]);

const seen = new WeakMap<Bench, Record<string, unknown>>();
/** The module's latest visual (a frame holds only what changed since the last one). */
function visual(b: Bench): Record<string, unknown> {
  for (const [id, v] of b.collectFrame().parts) if (id === 'tm') seen.set(b, v as Record<string, unknown>);
  return seen.get(b) ?? {};
}

const DIGITS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];

describe('TM1637 module (BT186)', () => {
  it('ACKs every byte from the eighth clock’s fall to the ninth’s, and shows an auto-increment write', () => {
    const d = new Driver();
    d.frame(0x40); // data: write, auto-increment
    d.frame(0xc0, DIGITS[1], DIGITS[2] | 0x80, DIGITS[3], DIGITS[4]); // from address 0, the colon on digit 2
    d.frame(0x88 | 7); // on, 14/16
    const b = bench(wired(), d.steps);
    for (const cycle of d.acks) {
      b.runUntil((cycle / 16) * NS_PER_US);
      expect(b.pinState('tm', 'DIO')?.level, `ACK at ${cycle}`).toBe(0);
    }
    b.runUntil(NS_PER_MS * 10);
    const v = visual(b);
    expect(sevenSegmentText(v.values as number[])).toBe('1234');
    expect(v.colon).toBe(14 / 16);
    expect(v.level).toBe(14 / 16);
    expect(b.pinState('tm', 'DIO')?.level).toBe(1); // released: the module's pull-up
  });

  it('writes a fixed address, ignores data past C5h, and sets the eight pulse widths', () => {
    for (const [code, sixteenths] of [
      [0, 1],
      [1, 2],
      [2, 4],
      [3, 10],
      [4, 11],
      [5, 12],
      [6, 13],
      [7, 14],
    ]) {
      const d = new Driver();
      d.frame(0x44); // fixed address
      d.frame(0xc3, DIGITS[9], DIGITS[8]); // both to digit 4: the last one stays
      d.frame(0xc6, DIGITS[5]); // no such register
      d.frame(0x88 | code);
      const b = bench(wired(), d.steps);
      b.runUntil(NS_PER_MS * 10);
      const v = visual(b);
      expect(sevenSegmentText(v.values as number[])).toBe('   8');
      expect(v.level).toBe(sixteenths / 16);
    }
  });

  it('is dark until display control turns it on, and off again with B3 clear', () => {
    const d = new Driver();
    d.frame(0x40);
    d.frame(0xc0, DIGITS[0], DIGITS[0], DIGITS[0], DIGITS[0]);
    const cut = d.cycle;
    d.frame(0x8f);
    const on = d.cycle;
    d.frame(0x87);
    const b = bench(wired(), d.steps);
    b.runUntil((cut / 16) * NS_PER_US);
    expect(sevenSegmentText(visual(b).values as number[])).toBe('    ');
    b.runUntil((on / 16) * NS_PER_US + NS_PER_US);
    expect(sevenSegmentText(visual(b).values as number[])).toBe('0000');
    b.runUntil(NS_PER_MS * 10);
    expect(visual(b).level).toBe(0);
  });

  it('answers a key read with 0xFF, LSB first, and drops a byte cut by STOP', () => {
    const d = new Driver();
    d.frame(0x40);
    d.start();
    d.byte(0xc0);
    d.byte(DIGITS[7]);
    d.partial(DIGITS[8], 4); // half a byte, then STOP: dropped
    d.stop();
    d.frame(0x8f);
    d.start();
    d.byte(0x42);
    const reads: number[] = [];
    for (let i = 0; i < 8; i++) {
      d.steps.push({ cycle: d.cycle, pin: 'D2', mode: 'output', level: 0 });
      d.cycle += STEP;
      d.steps.push({ cycle: d.cycle, pin: 'D2', mode: 'input', level: 0 });
      reads.push(d.cycle + STEP / 2);
      d.cycle += STEP;
    }
    d.steps.push({ cycle: d.cycle, pin: 'D2', mode: 'output', level: 0 });
    d.cycle += STEP;
    d.steps.push({ cycle: d.cycle, pin: 'D2', mode: 'input', level: 0 });
    const keyAck = d.cycle + STEP / 2;
    d.cycle += STEP;
    d.steps.push({ cycle: d.cycle, pin: 'D2', mode: 'output', level: 0 });
    d.cycle += STEP;
    d.stop();
    const b = bench(wired(), d.steps);
    let key = 0;
    reads.forEach((cycle, i) => {
      b.runUntil((cycle / 16) * NS_PER_US);
      key |= (b.pinState('tm', 'DIO')?.level ?? 0) << i;
    });
    expect(key).toBe(0xff);
    b.runUntil((keyAck / 16) * NS_PER_US);
    expect(b.pinState('tm', 'DIO')?.level).toBe(0);
    b.runUntil(NS_PER_MS * 20);
    expect(sevenSegmentText(visual(b).values as number[])).toBe('7   ');
  });

  it('runs from 3.3 V, not unpowered, and its pull-ups need power', () => {
    const d = new Driver();
    d.frame(0x40);
    d.frame(0xc0, DIGITS[3], DIGITS[3], DIGITS[3], DIGITS[3]);
    d.frame(0x8f);
    const low = bench(testDoc({ uno: 'fake-uno', tm: 'tm1637-4digit' }, [['uno:D2', 'tm:CLK'], ['uno:D3', 'tm:DIO'], ['tm:GND', 'uno:GND']]), d.steps);
    low.runUntil(NS_PER_MS * 10);
    expect(low.pinState('tm', 'DIO')?.level).toBeNull();
    const esp = { ...fakeBoard('fake-esp', PINS, 'esp32'), type: 'fake-esp' };
    const mcu = new FakeMcu({ kind: 'esp32', pins: PINS, script: d.steps });
    const b = new Bench(
      testDoc({ uno: 'fake-esp', tm: 'tm1637-4digit' }, [
        ['uno:D2', 'tm:CLK'],
        ['uno:D3', 'tm:DIO'],
        ['tm:VCC', 'uno:3V3'],
        ['tm:GND', 'uno:GND'],
      ]),
      makeBenchEnv([esp, tm1637FourDigit], () => mcu),
    );
    b.runUntil(NS_PER_MS * 10);
    expect(sevenSegmentText(visual(b).values as number[])).toBe('3333');
  });
});
