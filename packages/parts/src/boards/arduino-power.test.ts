import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartProps, type ProjectDoc, type Wire } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT201: the Uno, Nano and Mega powered from their pins — USB as before, VIN through the 5 V
// regulator, the 5V pin directly, the 3.3 V rail, the brown-out and its power-on reset with real
// firmware, the problems.

const env: BenchEnv = { part: benchEnvParts, createMcu: (board) => avrMcuFactory(board) };

function circuit(board: { type: string; props?: PartProps }, parts: { id: string; type: string; props?: PartProps }[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'power test',
    parts: [{ id: 'b', type: board.type, x: 0, y: 0, rotation: 0, props: board.props ?? {} }, ...parts.map((p, i) => ({ id: p.id, type: p.type, x: 100 + i * 30, y: 0, rotation: 0 as const, props: p.props ?? {} }))],
    wires: wires.map(([from, to], i): Wire => {
      const [fp, fn] = from.split(':');
      const [tp, tn] = to.split(':');
      return { id: `w${i}`, from: { part: fp, pin: fn }, to: { part: tp, pin: tn }, waypoints: [], color: 'red' };
    }),
    firmware: {},
  };
}

function load(doc: ProjectDoc, firmware = 'uno/blink') {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env);
  bench.attachFirmware('b', { format: 'hex', text: readFixtureText(`fixtures/firmware/${firmware}.hex`) });
  bench.reset();
  let serial = '';
  bench.onSerial('b', (bytes) => (serial += String.fromCharCode(...bytes)));
  const volts = (pin: string): number | null => {
    const s = bench.pinState('b', pin);
    return s === undefined || s.level === null ? null : Math.round(s.volts * 100) / 100;
  };
  const codes = (): string[] => bench.problems().map((p) => p.code);
  const visual = (): Record<string, unknown> => {
    let v: Record<string, unknown> = {};
    for (const [id, state] of bench.collectFrame().parts) if (id === 'b') v = state as Record<string, unknown>;
    return v;
  };
  return { bench, serial: () => serial, volts, codes, visual };
}

const supplyOn = (pin: string): [string, string][] => [
  ['psu:+', `b:${pin}`],
  ['psu:-', 'b:GND.1'],
];

describe('Arduino boards powered from their pins (BT201)', () => {
  it('on USB, as before: 5 V and 3.3 V rails, IOREF at 5 V, powered, the ON LED lit', () => {
    for (const type of ['arduino-uno', 'arduino-mega', 'arduino-nano']) {
      const { bench, volts, codes } = load(circuit({ type }, [], []), type === 'arduino-mega' ? 'mega/chaser' : 'uno/blink');
      bench.runUntil(NS_PER_MS);
      expect([volts('5V'), volts('3.3V')], type).toEqual([5, 3.3]);
      if (type !== 'arduino-nano') expect(volts('IOREF'), type).toBe(5);
      expect(bench.boardPowered('b')).toBe(true);
      expect(codes().filter((c) => c.startsWith('board-'))).toEqual([]);
    }
  });

  it('off USB: VIN through the 5 V regulator (its dropout below 6.1 V), the 3.3 V rail from it; too low, the brown-out', () => {
    const { bench, volts, codes, visual } = load(circuit({ type: 'arduino-uno', props: { usbPowered: false } }, [{ id: 'psu', type: 'bench-supply', props: { volts: 9 } }], supplyOn('VIN')));
    bench.runUntil(2 * NS_PER_MS);
    expect([volts('5V'), volts('3.3V'), volts('IOREF')]).toEqual([5, 3.3, 5]);
    expect(bench.boardPowered('b')).toBe(true);
    expect(visual()).toMatchObject({ ledPower: true });
    bench.input('psu', { kind: 'value', value: 6 });
    bench.runUntil(3 * NS_PER_MS);
    expect([volts('5V'), volts('3.3V')]).toEqual([4.9, 3.3]);
    bench.input('psu', { kind: 'value', value: 4.6 }); // 3.5 V: runs, out of its 16 MHz spec
    bench.runUntil(4 * NS_PER_MS);
    expect(volts('5V')).toBe(3.5);
    expect(bench.boardPowered('b')).toBe(true);
    expect(codes()).toContain('board-undervoltage');
    bench.input('psu', { kind: 'value', value: 3.5 }); // 2.4 V: under the 2.7 V brown-out
    bench.runUntil(5 * NS_PER_MS);
    expect(volts('5V')).toBe(2.4);
    expect(bench.boardPowered('b')).toBe(false);
    expect(codes()).toContain('board-unpowered');
    expect(codes()).not.toContain('board-undervoltage');
    expect(visual()).toMatchObject({ ledPower: true }); // the ON LED still glows at 2.4 V
    bench.input('psu', { kind: 'value', value: 1 });
    bench.runUntil(6 * NS_PER_MS);
    expect([volts('5V'), volts('3.3V')]).toEqual([null, null]);
    expect(visual()).toMatchObject({ ledPower: false });
  });

  it('the 5V pin fed directly (four AA cells: 6 V, the ATmega’s limit); more is board-overvoltage, as is VIN over 20 V', () => {
    const cells = load(circuit({ type: 'arduino-uno', props: { usbPowered: false } }, [{ id: 'bat', type: 'battery-4aa' }], [
      ['bat:+', 'b:5V'],
      ['bat:-', 'b:GND.2'],
    ]));
    cells.bench.runUntil(2 * NS_PER_MS);
    expect([cells.volts('5V'), cells.volts('3.3V')]).toEqual([6, 3.3]);
    expect(cells.bench.boardPowered('b')).toBe(true);
    expect(cells.codes().filter((c) => c.startsWith('board-'))).toEqual([]);
    const high = load(circuit({ type: 'arduino-uno', props: { usbPowered: false } }, [{ id: 'psu', type: 'bench-supply', props: { volts: 6.5 } }], supplyOn('5V')));
    high.bench.runUntil(NS_PER_MS);
    expect(high.bench.problems().find((p) => p.code === 'board-overvoltage')?.severity).toBe('error');
    const vin = load(circuit({ type: 'arduino-uno' }, [{ id: 'psu', type: 'bench-supply', props: { volts: 24 } }], supplyOn('VIN')));
    vin.bench.runUntil(NS_PER_MS);
    expect(vin.bench.problems().find((p) => p.code === 'board-overvoltage')?.message).toContain('VIN is at 24.00 V');
  });

  it('nothing on its pins and USB off: board-unpowered, the sketch never runs; on USB, VIN over 6.6 V takes over from it', () => {
    const none = load(circuit({ type: 'arduino-uno', props: { usbPowered: false } }, [], []));
    none.bench.runUntil(1500 * NS_PER_MS);
    expect(none.bench.boardPowered('b')).toBe(false);
    expect(none.codes()).toContain('board-unpowered');
    expect(none.bench.pinState('b', '13')?.level).toBeNull(); // blink's LED pin floats
    expect(none.visual()).toMatchObject({ ledPower: false, ledL: 0 });
    // On USB with 6 V on VIN the rail stays USB's 5 V (the regulator gives 4.9).
    const both = load(circuit({ type: 'arduino-uno' }, [{ id: 'psu', type: 'bench-supply', props: { volts: 6 } }], supplyOn('VIN')));
    both.bench.runUntil(NS_PER_MS);
    expect(both.volts('5V')).toBe(5);
  });

  it('a brown-out and back: the power-on reset reruns setup() — uno/eeprom-counter counts its boots', () => {
    const { bench, serial } = load(circuit({ type: 'arduino-uno', props: { usbPowered: false } }, [{ id: 'psu', type: 'bench-supply', props: { volts: 9 } }], supplyOn('VIN')), 'uno/eeprom-counter');
    bench.runUntil(200 * NS_PER_MS);
    expect(serial()).toContain('boot 1');
    bench.input('psu', { kind: 'value', value: 3 }); // 1.9 V
    bench.runUntil(400 * NS_PER_MS);
    expect(bench.boardPowered('b')).toBe(false);
    const quiet = serial();
    bench.input('psu', { kind: 'value', value: 9 });
    bench.runUntil(600 * NS_PER_MS);
    expect(serial().slice(quiet.length)).toContain('boot 2');
    expect(bench.boardPowered('b')).toBe(true);
  });

  it('the Nano’s 3.3V comes from its USB chip: off USB it’s gone; the Mega’s 16 MHz wants 4.5 V', () => {
    const nano = load(circuit({ type: 'arduino-nano', props: { usbPowered: false } }, [{ id: 'psu', type: 'bench-supply', props: { volts: 9 } }], supplyOn('VIN')));
    nano.bench.runUntil(NS_PER_MS);
    expect([nano.volts('5V'), nano.volts('3.3V')]).toEqual([5, null]);
    expect(nano.bench.boardPowered('b')).toBe(true);
    const mega = load(circuit({ type: 'arduino-mega', props: { usbPowered: false } }, [{ id: 'psu', type: 'bench-supply', props: { volts: 5.4 } }], supplyOn('VIN')), 'mega/chaser');
    mega.bench.runUntil(NS_PER_MS);
    expect(mega.volts('5V')).toBe(4.3);
    expect(mega.codes()).toContain('board-undervoltage');
  });
});
