import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartProps, type ProjectDoc, type Wire } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { rp2040McuFactory } from '@benchtop/rp2040';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT202: the ESP32 boards and the Picos powered from their pins — USB as before; the DevKits from
// VIN/5V through their LDO or from 3V3; the Picos from VSYS through the buck-boost, 3V3_EN; the
// brown-out and the power-on reset with real firmware; the problems.

const esp32 = esp32McuFactory(loadCachedRom());
const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => (board.mcu === 'rp2040' ? rp2040McuFactory(board, id, report) : esp32(board, id, report)) };

function circuit(type: string, props: PartProps, parts: { id: string; type: string; props?: PartProps }[], wires: [string, string][]): ProjectDoc {
  return {
    format: 1,
    name: 'power test',
    parts: [{ id: 'b', type, x: 0, y: 0, rotation: 0, props }, ...parts.map((p, i) => ({ id: p.id, type: p.type, x: 100 + i * 30, y: 0, rotation: 0 as const, props: p.props ?? {} }))],
    wires: wires.map(([from, to], i): Wire => {
      const [fp, fn] = from.split(':');
      const [tp, tn] = to.split(':');
      return { id: `w${i}`, from: { part: fp, pin: fn }, to: { part: tp, pin: tn }, waypoints: [], color: 'red' };
    }),
    firmware: {},
  };
}

function load(doc: ProjectDoc, firmware?: string) {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env);
  if (firmware?.startsWith('esp32/')) bench.attachFirmware('b', { format: 'esp32-bin', app: readFixture(`fixtures/firmware/${firmware}.bin`), partitions: readFixture(`fixtures/firmware/${firmware}.partitions.bin`) });
  else if (firmware !== undefined) bench.attachFirmware('b', { format: 'uf2', bytes: readFixture(`fixtures/firmware/${firmware}.uf2`) });
  bench.reset();
  const volts = (pin: string): number | null => {
    const s = bench.pinState('b', pin);
    return s === undefined || s.level === null ? null : Math.round(s.volts * 100) / 100;
  };
  const codes = (): string[] => bench.problems().map((p) => p.code);
  /** GPIO edges on `pin` while running to `until` ms. */
  const edges = (pin: string, until: number): number => {
    let n = 0;
    let last = bench.pinState('b', pin)?.level;
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 10; t <= until; t += 10) {
      bench.runUntil(t * NS_PER_MS);
      const level = bench.pinState('b', pin)?.level;
      if (level !== last) n++;
      last = level;
    }
    return n;
  };
  return { bench, volts, codes, edges };
}

const supplyOn = (pin: string, ground = 'GND.1'): [string, string][] => [
  ['psu:+', `b:${pin}`],
  ['psu:-', `b:${ground}`],
];
const psu = (volts: number) => [{ id: 'psu', type: 'bench-supply', props: { volts } }];

describe('ESP32 boards and Picos powered from their pins (BT202)', () => {
  it('on USB, as before: the 3V3 rail and the USB pins, powered', () => {
    for (const [type, usb, rail] of [
      ['esp32-devkit-v1', 'VIN', '3V3'],
      ['esp32-c3-devkitm-1', '5V.1', '3V3.1'],
      ['esp32-s3-devkitc-1', '5V', '3V3.1'],
      ['esp32-s2-devkitm-1', '5V', '3V3'],
      ['raspberry-pi-pico', 'VSYS', '3V3'],
      ['raspberry-pi-pico-2', 'VBUS', '3V3'],
    ] as const) {
      const { bench, volts, codes } = load(circuit(type, {}, [], []));
      bench.runUntil(NS_PER_MS / 10);
      expect([volts(usb), volts(rail)], type).toEqual([5, 3.3]);
      expect(codes().filter((c) => c.startsWith('board-')), type).toEqual([]);
    }
  });

  it('the DevKit V1 off USB: VIN through its AMS1117 (low VIN, low 3V3), 3V3 fed directly, too much on either', () => {
    const vin = load(circuit('esp32-devkit-v1', { usbPowered: false }, psu(9), supplyOn('VIN')));
    vin.bench.runUntil(NS_PER_MS / 10);
    expect(vin.volts('3V3')).toBe(3.3);
    vin.bench.input('psu', { kind: 'value', value: 4 }); // 2.9 V: runs, out of its module's spec
    vin.bench.runUntil(NS_PER_MS / 5);
    expect(vin.volts('3V3')).toBe(2.9);
    expect(vin.bench.boardPowered('b')).toBe(true);
    expect(vin.codes()).toContain('board-undervoltage');
    vin.bench.input('psu', { kind: 'value', value: 3.4 }); // 2.3 V: under the 2.43 V brown-out
    vin.bench.runUntil(NS_PER_MS / 2);
    expect(vin.bench.boardPowered('b')).toBe(false);
    expect(vin.codes()).toContain('board-unpowered');
    vin.bench.input('psu', { kind: 'value', value: 18 });
    vin.bench.runUntil(NS_PER_MS);
    expect(vin.bench.problems().find((p) => p.code === 'board-overvoltage')?.message).toContain('VIN is at 18.00 V');
    const direct = load(circuit('esp32-devkit-v1', { usbPowered: false }, psu(3.3), supplyOn('3V3')));
    direct.bench.runUntil(NS_PER_MS / 10);
    expect([direct.volts('3V3'), direct.volts('VIN')]).toEqual([3.3, null]);
    expect(direct.bench.boardPowered('b')).toBe(true);
    direct.bench.input('psu', { kind: 'value', value: 5 });
    direct.bench.runUntil(NS_PER_MS / 5);
    expect(direct.bench.problems().find((p) => p.code === 'board-overvoltage')?.message).toContain('3V3 rail is at 5.00 V');
  });

  it('esp32/blink on a 5 V supply through VIN: it blinks; the supply off, it stops and its LED pin floats; back on, it boots again', () => {
    const { bench, edges } = load(circuit('esp32-devkit-v1', { usbPowered: false }, psu(5), supplyOn('VIN')), 'esp32/blink');
    expect(edges('D2', 1300)).toBeGreaterThanOrEqual(2);
    bench.input('psu', { kind: 'value', value: 0 });
    bench.runUntil(bench.now() + NS_PER_MS);
    expect(bench.boardPowered('b')).toBe(false);
    expect(bench.pinState('b', 'D2')?.level).toBeNull();
    expect(edges('D2', Math.floor(bench.now() / NS_PER_MS) + 1100)).toBe(0);
    bench.input('psu', { kind: 'value', value: 5 });
    expect(edges('D2', Math.floor(bench.now() / NS_PER_MS) + 1300)).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('an Espressif DevKit from 5V: the C3 at 4 V gets 2.9 V; nothing on its pins and USB off, the S3 and S2 have no power', () => {
    // (Their MCUs aren't on this bench — the electrical side alone.)
    const c3 = load(circuit('esp32-c3-devkitm-1', { usbPowered: false }, psu(4), supplyOn('5V.2')));
    c3.bench.runUntil(NS_PER_MS / 10);
    expect([c3.volts('3V3.1'), c3.volts('3V3.2')]).toEqual([2.9, 2.9]);
    expect(c3.codes()).toContain('board-undervoltage');
    expect(c3.codes()).not.toContain('board-unpowered');
    for (const type of ['esp32-s3-devkitc-1', 'esp32-s2-devkitm-1']) {
      const off = load(circuit(type, { usbPowered: false }, [], []));
      off.bench.runUntil(NS_PER_MS / 10);
      expect(off.codes(), type).toContain('board-unpowered');
    }
  });

  it('a Pico from VSYS: 3.3 V from 1.8 to 5.5 V (two AA cells), 3V3_EN low turns it off, pico/blink stops and starts again', () => {
    const { volts, codes, edges } = load(circuit('raspberry-pi-pico', { usbPowered: false }, [{ id: 'bat', type: 'battery-2aa' }], [
      ['bat:+', 'b:VSYS'],
      ['bat:-', 'b:GND.1'],
    ]), 'pico/blink');
    expect(volts('3V3')).toBe(3.3);
    expect(volts('VBUS')).toBeNull();
    expect(volts('3V3_EN')).toBe(3); // the board's pull-up to VSYS
    expect(edges('TP5', 1200)).toBeGreaterThanOrEqual(2);
    expect(codes().filter((c) => c.startsWith('board-'))).toEqual([]);
    const low = load(circuit('raspberry-pi-pico', { usbPowered: false }, psu(3), [...supplyOn('VSYS'), ['b:3V3_EN', 'b:GND.2']]), 'pico/blink');
    expect(low.volts('3V3')).toBeNull();
    expect(low.edges('TP5', 1200)).toBe(0);
    expect(low.bench.boardPowered('b')).toBe(false);
    const range = load(circuit('raspberry-pi-pico', { usbPowered: false }, psu(1.6), supplyOn('VSYS')));
    range.bench.runUntil(NS_PER_MS / 10);
    expect(range.volts('3V3')).toBeNull(); // below the buck-boost's 1.8 V
    range.bench.input('psu', { kind: 'value', value: 6 });
    range.bench.runUntil(NS_PER_MS / 5);
    expect(range.volts('3V3')).toBe(3.3);
    expect(range.bench.problems().find((p) => p.code === 'board-overvoltage')?.message).toContain('VSYS is at 6.00 V');
  }, 60_000);
});
