import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, parseProject, type PartProps, type ProjectDoc, type Wire } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT197: uno/rfid-uid — an RC522 on an Uno driven by the sketch's own few functions: the version,
// TAuto's timeout with nothing on the reader, REQA, anticollision, SELECT, MFAuthent and READ of a
// MIFARE Classic's block 0, an NTAG213's pages, HLTA. BT198: the same under the MFRC522 library
// 1.4.12 — uno/mfrc522-dump (PICC_DumpToSerial: every sector authenticated and read, an NTAG's
// pages) and esp32/mfrc522-logger (a visit counter on the card: authenticate, read, write, read back).

const esp32 = esp32McuFactory(loadCachedRom());
const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => avrMcuFactory(board) ?? esp32(board, id, report) };

const UNO = ['10', '13', '11', '12', '9', 'GND.1', '3.3V'];
const ESP32 = ['D5', 'D18', 'D23', 'D19', 'D22', 'GND.1', '3V3'];

function circuit(props: PartProps, supply = '3.3V', board = 'uno'): ProjectDoc {
  const pins = board === 'uno' ? [...UNO.slice(0, 6), supply] : ESP32;
  const wires: [string, string][] = ['SDA', 'SCK', 'MOSI', 'MISO', 'RST', 'GND', '3.3V'].map((name, i) => [`${board}:${pins[i]}`, `rfid:${name}`]);
  return {
    format: 1,
    name: 'rfid test',
    parts: [
      { id: board, type: board === 'uno' ? 'arduino-uno' : 'esp32-devkit-v1', x: 0, y: 0, rotation: 0, props: {} },
      { id: 'rfid', type: 'rc522', x: 100, y: 0, rotation: 0, props },
    ],
    wires: wires.map(([from, to], i): Wire => {
      const [fp, fn] = from.split(':');
      const [tp, tn] = to.split(':');
      return { id: `w${i}`, from: { part: fp, pin: fn }, to: { part: tp, pin: tn }, waypoints: [], color: 'green' };
    }),
    firmware: {},
  };
}

function load(doc: ProjectDoc, firmware = 'uno/rfid-uid') {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env);
  const board = parsed.doc.parts[0].id;
  if (board === 'uno') bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/${firmware}.hex`) });
  else bench.attachFirmware(board, { format: 'esp32-bin', app: readFixture(`fixtures/firmware/${firmware}.bin`), partitions: readFixture(`fixtures/firmware/${firmware}.partitions.bin`) });
  bench.reset();
  let text = '';
  const lines: string[] = [];
  bench.onSerial(board, (bytes) => {
    text += String.fromCharCode(...bytes);
    let end: number;
    while ((end = text.indexOf('\n')) >= 0) {
      lines.push(text.slice(0, end).replace(/\r$/, ''));
      text = text.slice(end + 1);
    }
  });
  /** Runs in 10 ms slices until a line from `from` on matches `test` (at most to `limit` ms). */
  const until = (test: (line: string) => boolean, limit: number, from = 0): string | undefined => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 10; t <= limit; t += 10) {
      bench.runUntil(t * NS_PER_MS);
      const line = lines.slice(from).find(test);
      if (line !== undefined) return line;
    }
    return undefined;
  };
  return { bench, lines, until };
}

describe('an RC522 on real firmware (BT197)', () => {
  it('uno/rfid-uid: the version, the 25 ms timeout, a MIFARE Classic card read and halted, then the fob', () => {
    const { bench, lines, until } = load(circuit({}));
    const timeout = until((l) => l.startsWith('no card ') || l.startsWith('card '), 500);
    expect(lines[0]).toBe('version 0x92');
    const us = Number(/(\d+) us/.exec(timeout ?? '')?.[1]);
    // REQA's 85 µs on air, then (2·169 + 1)·1001 / 13.56 MHz = 25.025 ms, then the sketch's polling.
    expect(timeout?.startsWith('no card ')).toBe(true);
    expect(us).toBeGreaterThan(25_100);
    expect(us).toBeLessThan(25_700);
    bench.input('rfid', { kind: 'press' });
    const from = lines.length;
    expect(until((l) => l === 'halted', 1000, from)).toBe('halted');
    const bcc = (0xa3 ^ 0xf1 ^ 0xc5 ^ 0x2e).toString(16).toUpperCase();
    expect(lines.slice(from)).toEqual(['uid A3 F1 C5 2E sak 08 atqa 00 04', `block0 A3 F1 C5 2E ${bcc} 08 04 00 42 45 4E 43 48 54 4F 50`, 'halted']);
    // Halted, it stays quiet while it lies there.
    until(() => false, Math.floor(bench.now() / NS_PER_MS) + 500);
    expect(lines.length).toBe(from + 3);
    // The fob instead: a new tag, read once.
    bench.input('rfid', { kind: 'key', key: 'fob', down: true });
    const fob = until((l) => l.startsWith('uid '), Math.floor(bench.now() / NS_PER_MS) + 500, from + 3);
    expect(fob).toBe('uid 5B 7E 0D 19 sak 08 atqa 00 04');
    expect(bench.problems().filter((p) => p.code === 'spi-unattached' || p.code === 'rc522-overvoltage')).toEqual([]);
  }, 30_000);

  it('uno/rfid-uid: an NTAG213 — two cascade levels, SAK 00h, its first four pages', () => {
    const { lines, until } = load(circuit({ card: 'ntag213', uid: '04 3C 8A 52 B1 6E 80', present: 'card' }));
    expect(until((l) => l === 'halted', 1000)).toBe('halted');
    expect(lines.find((l) => l.startsWith('card '))).toBeDefined(); // already on the reader at the first REQA
    expect(lines).toContain('uid 04 3C 8A 52 B1 6E 80 sak 00 atqa 00 44');
    const bcc0 = (0x88 ^ 0x04 ^ 0x3c ^ 0x8a).toString(16).toUpperCase();
    const bcc1 = (0x52 ^ 0xb1 ^ 0x6e ^ 0x80).toString(16).toUpperCase().padStart(2, '0');
    expect(lines).toContain(`pages 04 3C 8A ${bcc0} 52 B1 6E 80 ${bcc1} 48 00 00 E1 10 12 00`);
  }, 30_000);

  it('uno/rfid-uid: wired to 5 V it says nothing — rc522-overvoltage', () => {
    const { bench, lines, until } = load(circuit({ present: 'card' }, '5V'));
    until(() => false, 300);
    expect(lines[0]).toBe('version 0xFF');
    expect(lines.some((l) => l.startsWith('uid '))).toBe(false);
    expect(bench.problems().map((p) => p.code)).toContain('rc522-overvoltage');
  }, 30_000);

  it('BT198: uno/mfrc522-dump — the library’s PCD_Init and PICC_DumpToSerial: the version, every sector authenticated with key A and read, once', () => {
    const { bench, lines, until } = load(circuit({ present: 'card' }), 'uno/mfrc522-dump');
    expect(until((l) => l === 'done', 3000)).toBe('done');
    expect(lines.slice(0, 5)).toEqual(['Firmware Version: 0x92 = v2.0', 'ready', 'Card UID: A3 F1 C5 2E', 'Card SAK: 08', 'PICC type: MIFARE 1KB']);
    const blocks = lines.filter((l) => /^ *(\d+ +)?\d+   [0-9A-F]{2} /.test(l)).map((l) => l.trim().replace(/\s+/g, ' '));
    expect(blocks).toHaveLength(64);
    expect(blocks[0]).toBe('15 63 00 00 00 00 00 00 FF 07 80 69 FF FF FF FF FF FF [ 0 0 1 ]'); // key A reads as zeros
    expect(blocks[63]).toBe('0 A3 F1 C5 2E B9 08 04 00 42 45 4E 43 48 54 4F 50 [ 0 0 0 ]');
    // PICC_DumpToSerial ends with HLTA: the card isn't dumped again while it lies there.
    until(() => false, Math.floor(bench.now() / NS_PER_MS) + 500);
    expect(lines.filter((l) => l === 'done')).toHaveLength(1);
  }, 30_000);

  it('BT198: uno/mfrc522-dump — an NTAG213 is "MIFARE Ultralight or Ultralight C" with its pages', () => {
    const { lines, until } = load(circuit({ present: 'card', card: 'ntag213', uid: '04 3C 8A 52 B1 6E 80' }), 'uno/mfrc522-dump');
    expect(until((l) => l === 'done', 3000)).toBe('done');
    expect(lines).toContain('PICC type: MIFARE Ultralight or Ultralight C');
    expect(lines).toContain('Card UID: 04 3C 8A 52 B1 6E 80');
    expect(lines.map((l) => l.trim())).toEqual(expect.arrayContaining(['2   0D 48 00 00', '3   E1 10 12 00', '4   03 00 FE 00']));
  }, 30_000);

  it('BT198: esp32/mfrc522-logger — a visit counter on the card: authenticated, read, written, read back; kept on the card over a reset', () => {
    const { bench, lines, until } = load(circuit({ present: 'card' }, '3V3', 'esp'), 'esp32/mfrc522-logger');
    expect(until((l) => l.startsWith('card '), 400)).toMatch(/^card A3 F1 C5 2E visit 1 at \d+ ms$/);
    bench.input('rfid', { kind: 'release' });
    until(() => false, Math.floor(bench.now() / NS_PER_MS) + 40);
    bench.input('rfid', { kind: 'press' });
    const from = lines.length;
    expect(until((l) => l.startsWith('card '), Math.floor(bench.now() / NS_PER_MS) + 100, from)).toMatch(/visit 2 at/);
    // A bench reset is a power-up for the board and the reader; the card on it keeps its data.
    bench.reset();
    lines.length = 0;
    expect(until((l) => l.startsWith('card '), 400)).toMatch(/visit 3 at/);
    expect(lines.some((l) => / (auth|read|write|read back) /.test(l))).toBe(false);
  }, 60_000);
});
