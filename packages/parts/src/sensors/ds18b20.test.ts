import { Bench, NS_PER_US, type PartDefinition, type ProjectDoc } from '@benchtop/core';
import { FakeMcu, fakeBoard, makeBenchEnv, testDoc } from '@benchtop/core/testing';
import { describe, expect, it } from 'vitest';
import { resistor } from '../basic/resistor.ts';
import { CONVERT_NS, crc8, ds18b20, rawCelsius, romCode, temperatureRaw } from './ds18b20.ts';

// BT187: the DS18B20 against a scripted 1-Wire master with the OneWire library's timings (reset
// 480/70/410 µs, write 1 10/55, write 0 65/5, read 3/10/53), reading the line between slots so a
// search can choose its path as it goes.

const board = fakeBoard('fake-uno', ['D2']);
const parts: PartDefinition[] = [board, ds18b20, resistor];

class Master {
  readonly bench: Bench;
  private readonly mcu: FakeMcu;
  t = 10 * NS_PER_US;

  constructor(doc: ProjectDoc) {
    this.mcu = new FakeMcu({ pins: ['D2'] });
    this.bench = new Bench(doc, makeBenchEnv(parts, () => this.mcu));
    this.bench.runUntil(this.t);
  }

  /** Pulls the line low for `lowUs`, then releases it; returns the line `sampleUs` after the fall. */
  private slot(lowUs: number, sampleUs: number, totalUs: number): number | null {
    const cycle = (ns: number): number => Math.round((ns * 16) / 1000);
    const start = this.t;
    this.mcu.setScript([
      { cycle: cycle(start), pin: 'D2', mode: 'output', level: 0 },
      { cycle: cycle(start + lowUs * NS_PER_US), pin: 'D2', mode: 'input', level: 0 },
    ]);
    this.bench.runUntil(start + sampleUs * NS_PER_US);
    const level = this.bench.pinState('ow', 'DQ')?.level ?? null;
    this.t = start + totalUs * NS_PER_US;
    this.bench.runUntil(this.t);
    return level;
  }

  /** True when a presence pulse answered. */
  reset(): boolean {
    return this.slot(480, 480 + 70, 960) === 0;
  }
  writeBit(bit: number): void {
    if (bit) this.slot(10, 10, 65);
    else this.slot(65, 65, 70);
  }
  readBit(): number {
    return this.slot(3, 13, 66) === 0 ? 0 : 1;
  }
  write(...bytes: number[]): void {
    for (const b of bytes) for (let i = 0; i < 8; i++) this.writeBit((b >> i) & 1);
  }
  read(count: number): number[] {
    const out: number[] = [];
    for (let n = 0; n < count; n++) {
      let b = 0;
      for (let i = 0; i < 8; i++) b |= this.readBit() << i;
      out.push(b);
    }
    return out;
  }
  /** Waits `us` with the line released. */
  idle(us: number): void {
    this.t += us * NS_PER_US;
    this.bench.runUntil(this.t);
  }

  /** Every ROM code on the line (Maxim's search algorithm). */
  search(command = 0xf0): number[][] {
    const found: number[][] = [];
    let lastDiscrepancy = -1;
    let previous: number[] = new Array<number>(64).fill(0);
    for (;;) {
      if (!this.reset()) return found;
      this.write(command);
      const bits: number[] = [];
      let discrepancy = -1;
      for (let i = 0; i < 64; i++) {
        const bit = this.readBit();
        const complement = this.readBit();
        if (bit === 1 && complement === 1) return found; // nobody left
        let choice: number;
        if (bit !== complement) choice = bit;
        else {
          choice = i < lastDiscrepancy ? previous[i] : i === lastDiscrepancy ? 1 : 0;
          if (choice === 0) discrepancy = i;
        }
        bits.push(choice);
        this.writeBit(choice);
      }
      const rom: number[] = [];
      for (let b = 0; b < 8; b++) rom.push(bits.slice(b * 8, b * 8 + 8).reduce((a, v, i) => a | (v << i), 0));
      found.push(rom);
      previous = bits;
      lastDiscrepancy = discrepancy;
      if (discrepancy < 0) return found;
    }
  }
}

/** One sensor (`ow`) on D2 with a 4.7 kΩ pull-up; a second (`ow2`) on the same line when given. */
function line(props: Record<string, unknown> = {}, second?: Record<string, unknown>, pullup = true): ProjectDoc {
  const ids: Record<string, string> = { uno: 'fake-uno', ow: 'ds18b20' };
  const wires: [string, string][] = [
    ['uno:D2', 'ow:DQ'],
    ['ow:VDD', 'uno:5V'],
    ['ow:GND', 'uno:GND'],
  ];
  if (pullup) {
    ids.r = 'resistor';
    wires.push(['r:1', 'uno:D2'], ['r:2', 'uno:5V']);
  }
  if (second !== undefined) {
    ids.ow2 = 'ds18b20';
    wires.push(['ow2:DQ', 'uno:D2'], ['ow2:VDD', 'uno:5V'], ['ow2:GND', 'uno:GND']);
  }
  return testDoc(ids, wires, { ow: props as never, ow2: (second ?? {}) as never, r: { ohms: 4700 } });
}

describe('DS18B20 (BT187)', () => {
  it('has the datasheet’s CRC-8, ROM layout and temperature format (Table 2)', () => {
    // Maxim AN27's example: the ROM code 02 1C B8 01 00 00 00 has CRC A2.
    expect(crc8([0x02, 0x1c, 0xb8, 0x01, 0x00, 0x00, 0x00])).toBe(0xa2);
    const rom = romCode('0000075a1b2c');
    expect([...rom.slice(0, 7)]).toEqual([0x28, 0x2c, 0x1b, 0x5a, 0x07, 0x00, 0x00]);
    expect(crc8(rom)).toBe(0); // the CRC byte zeroes the register
    for (const [celsius, raw] of [
      [125, 0x07d0],
      [85, 0x0550],
      [25.0625, 0x0191],
      [10.125, 0x00a2],
      [0.5, 0x0008],
      [0, 0],
      [-0.5, 0xfff8],
      [-10.125, 0xff5e],
      [-25.0625, 0xfe6f],
      [-55, 0xfc90],
    ]) {
      expect(temperatureRaw(celsius, 12), `${celsius}`).toBe(raw);
      expect(rawCelsius(raw)).toBe(celsius);
    }
    expect(temperatureRaw(21.3, 9)).toBe(0x0158); // 21.5 °C, the nearest half degree
  });

  it('answers a reset with presence, reads its ROM, and powers up with 85 °C in the scratchpad', () => {
    const m = new Master(line({ serial: '0000075a1b2c' }));
    expect(m.reset()).toBe(true);
    m.write(0x33);
    expect(m.read(8)).toEqual([...romCode('0000075a1b2c')]);
    expect(m.reset()).toBe(true);
    m.write(0xcc, 0xbe);
    const pad = m.read(9);
    expect(pad.slice(0, 8)).toEqual([0x50, 0x05, 0x4b, 0x46, 0x7f, 0xff, 0x0c, 0x10]);
    expect(pad[8]).toBe(crc8(pad, 8));
    expect(m.read(1)).toEqual([0xff]); // past the CRC: 1s
  });

  it('converts in the resolution’s time, busy reads 0 until then, and rounds to its step', () => {
    for (const [config, bits] of [
      [0x1f, 9],
      [0x3f, 10],
      [0x5f, 11],
      [0x7f, 12],
    ]) {
      const m = new Master(line({ temperature: 23.3 }));
      m.reset();
      m.write(0xcc, 0x4e, 0x50, 0x0a, config);
      m.reset();
      m.write(0xcc, 0x44);
      const started = m.t;
      let polls = 0;
      while (m.readBit() === 0) polls++;
      const took = m.t - started;
      expect(polls, `${bits} bits`).toBeGreaterThan(0);
      // It starts at the command's last bit; polls are 66 µs read slots.
      expect(took).toBeGreaterThan(CONVERT_NS[bits - 9] - 100 * NS_PER_US);
      expect(took).toBeLessThan(CONVERT_NS[bits - 9] + 200 * NS_PER_US);
      m.reset();
      m.write(0xcc, 0xbe);
      const pad = m.read(9);
      expect(rawCelsius(pad[0] | (pad[1] << 8))).toBe(rawCelsius(temperatureRaw(23.3, bits)));
      expect(pad[4]).toBe(config);
      expect(pad[8]).toBe(crc8(pad, 8));
    }
  });

  it('matches a ROM, finds two sensors by Search ROM, and alarm-searches the one out of range', () => {
    const a = romCode('000000000a01');
    const b = romCode('000000000b02');
    const m = new Master(line({ serial: '000000000a01', temperature: 30 }, { serial: '000000000b02', temperature: 18 }));
    const names = (roms: number[][]): string[] => roms.map((r) => r.join(',')).sort();
    expect(names(m.search())).toEqual(names([[...a], [...b]]));
    // Both: TH 25, TL 20 — then convert together (skip ROM) and alarm-search: only a (30 °C).
    m.reset();
    m.write(0xcc, 0x4e, 25, 20, 0x1f);
    m.reset();
    m.write(0xcc, 0x44);
    m.idle(100_000);
    expect(names(m.search(0xec))).toEqual(names([[...a], [...b]]));
    // b at 18 °C is below TL 20 too: both alarm. Raise b to 22 and convert again: only a.
    m.bench.input('ow2', { kind: 'key', key: 'set:temperature=22', down: true });
    m.reset();
    m.write(0xcc, 0x44);
    m.idle(100_000);
    expect(m.search(0xec)).toEqual([[...a]]);
    // Match ROM: only b answers its scratchpad read.
    m.reset();
    m.write(0x55, ...b, 0xbe);
    const pad = m.read(2);
    expect(rawCelsius(pad[0] | (pad[1] << 8))).toBe(22);
  });

  it('copies the scratchpad to the EEPROM (busy 10 ms), recalls it, and reports its power supply', () => {
    const m = new Master(line());
    m.reset();
    m.write(0xcc, 0x4e, 0x12, 0x34, 0x3f);
    m.reset();
    m.write(0xcc, 0x48);
    expect(m.readBit()).toBe(0);
    m.idle(10_000);
    expect(m.readBit()).toBe(1);
    m.reset();
    m.write(0xcc, 0x4e, 0, 0, 0x7f);
    m.reset();
    m.write(0xcc, 0xb8);
    m.reset();
    m.write(0xcc, 0xbe);
    expect(m.read(5).slice(2)).toEqual([0x12, 0x34, 0x3f]);
    m.reset();
    m.write(0xcc, 0xb4);
    expect(m.readBit()).toBe(1); // VDD powered
  });

  it('runs parasite-powered with VDD on GND, and warns without a pull-up', () => {
    const parasite = testDoc(
      { uno: 'fake-uno', ow: 'ds18b20', r: 'resistor' },
      [
        ['uno:D2', 'ow:DQ'],
        ['ow:VDD', 'uno:GND'],
        ['ow:GND', 'uno:GND'],
        ['r:1', 'uno:D2'],
        ['r:2', 'uno:5V'],
      ],
      { r: { ohms: 4700 } },
    );
    const m = new Master(parasite);
    expect(m.reset()).toBe(true);
    m.write(0xcc, 0xb4);
    expect(m.readBit()).toBe(0);
    const bare = new Master(line({}, undefined, false));
    bare.reset();
    expect(bare.bench.problems().map((p) => p.code)).toContain('onewire-no-pullup');
  });
});
