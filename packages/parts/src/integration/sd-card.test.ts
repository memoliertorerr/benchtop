import { avrMcuFactory } from '@benchtop/avr';
import { assembleBench, type Bench, type BenchEnv, type FirmwareImage, NS_PER_MS, type ProjectDoc } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { rp2040McuFactory } from '@benchtop/rp2040';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';
import { utf8Encode, utf8Text } from '../storage/text.ts';

// BT89: SD libraries on the microSD card model, with real firmware.

const esp32 = esp32McuFactory(loadCachedRom());
const env: BenchEnv = {
  part: benchEnvParts,
  createMcu: (board, id, report) => avrMcuFactory(board) ?? (board.mcu === 'esp32' ? esp32(board, id, report) : rp2040McuFactory(board, id, report)),
};

function project(name: string, edit?: (doc: ProjectDoc) => void): ProjectDoc {
  const doc = JSON.parse(readFixtureText(`fixtures/projects/${name}.json`)) as ProjectDoc;
  edit?.(doc);
  return doc;
}

function start(doc: ProjectDoc, board: string, image: FirmwareImage): { bench: Bench; serial: () => string } {
  const bench = assembleBench(doc, env, { [board]: image }, { analogSpecFor });
  let text = '';
  bench.onSerial(board, (bytes) => (text += String.fromCharCode(...bytes)));
  return { bench, serial: () => text };
}

/** Runs until `marker` shows on Serial (or `maxMs` passes). */
function runUntil(bench: Bench, serial: () => string, marker: string, maxMs: number): void {
  for (let t = 50; t <= maxMs && !serial().includes(marker); t += 50) bench.runUntil(t * NS_PER_MS);
}

const unoHex = (name: string): FirmwareImage => ({ format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${name}.hex`) });

describe('microSD card with real firmware (BT89)', () => {
  it('Uno + Arduino SD library: lists the power-up files, appends a log, reads it back; the files read back through storage', () => {
    const { bench, serial } = start(project('sd-log'), 'uno', unoHex('sd-log'));
    runUntil(bench, serial, 'done', 5000);
    const out = serial();
    expect(out).toContain('sd: ok\r\n');
    expect(out).toContain('file: CONFIG.TXT 8\r\n');
    expect(out).toContain('config: rate=10\n');
    expect(out).toContain('log: 24\r\nline 0\r\nline 1\r\nline 2\r\n');
    expect(out).toContain('done\r\n');
    const storage = bench.storage('sd');
    expect(storage).toBeDefined();
    const files = storage!.list().map((f) => [f.path, f.dir, f.size]);
    expect(files).toEqual([
      ['CONFIG.TXT', false, 8],
      ['LOG.TXT', false, 24],
      ['DATA', true, 0],
      ['DATA/A.CSV', false, 12],
    ]);
    expect(utf8Text(storage!.read('log.txt')!)).toBe('line 0\r\nline 1\r\nline 2\r\n');
    expect(utf8Text(storage!.read('data/a.csv')!)).toBe('t,v\r\n0,512\r\n');
    expect(storage!.version).toBeGreaterThan(0);

    // A reset keeps the card: the sketch runs again and the log grows.
    bench.reset();
    let again = '';
    bench.onSerial('uno', (bytes) => (again += String.fromCharCode(...bytes)));
    runUntil(bench, () => again, 'done', bench.now() / NS_PER_MS + 5000);
    expect(again).toContain('file: LOG.TXT 24\r\n');
    expect(again).toContain('log: 48\r\n');
  }, 60_000);

  it('a file put on the card from outside reads in the sketch; an empty socket fails SD.begin', () => {
    const doc = project('sd-log', (d) => {
      const sd = d.parts.find((p) => p.id === 'sd')!;
      sd.props = { files: JSON.stringify({ 'CONFIG.TXT': 'rate=99\n', 'notes/long name.txt': 'kept' }) };
    });
    const { bench, serial } = start(doc, 'uno', unoHex('sd-log'));
    expect(bench.storage('sd')!.write('EXTRA.BIN', utf8Encode('xyz'))).toBe(true);
    runUntil(bench, serial, 'done', 5000);
    expect(serial()).toContain('config: rate=99\n');
    expect(serial()).toContain('file: NOTES 32768\r\n'); // a directory: the SD library sizes it by its clusters
    expect(serial()).toContain('file: EXTRA.BIN 3\r\n');
    expect(utf8Text(bench.storage('sd')!.read('notes/long name.txt')!)).toBe('kept');

    const empty = project('sd-log', (d) => {
      d.parts.find((p) => p.id === 'sd')!.props = { inserted: false };
    });
    const none = start(empty, 'uno', unoHex('sd-log'));
    runUntil(none.bench, none.serial, 'failed', 5000);
    expect(none.serial()).toContain('sd: begin failed\r\n');
  }, 60_000);

  it('ESP32 + its core\'s SD library (FatFs, CRC on): lists, appends, writes a long name', () => {
    const image: FirmwareImage = {
      format: 'esp32-bin',
      app: readFixture('fixtures/firmware/esp32/sd-log.bin'),
      partitions: readFixture('fixtures/firmware/esp32/sd-log.partitions.bin'),
    };
    const { bench, serial } = start(project('esp32-sd-log'), 'esp', image);
    runUntil(bench, serial, 'done', 8000);
    const out = serial();
    expect(out).toContain('sd: ok 3 7580\n'); // CARD_SDHC, 15,523,840 blocks (printf: \n line ends)
    expect(out).toContain('file: config.txt 8\n');
    expect(out).toContain('config: rate=10\n');
    expect(out).toContain('log: 21\nline 0\nline 1\nline 2\n');
    expect(out).toContain('done\r\n');
    const storage = bench.storage('sd')!;
    expect(storage.list().map((f) => f.path)).toEqual(['config.txt', 'log.txt', 'data', 'data/Long Name Readings.csv']);
    expect(utf8Text(storage.read('DATA/long name readings.csv')!)).toBe('t,v\r\n0,512\r\n');
  }, 120_000);

  it('Pico + arduino-pico\'s SD library (SdFat): lists, appends, writes a long name', () => {
    const { bench, serial } = start(project('pico-sd-log'), 'pico', { format: 'uf2', bytes: readFixture('fixtures/firmware/pico/sd-log.uf2') });
    runUntil(bench, serial, 'done', 8000);
    const out = serial();
    expect(out).toContain('sd: ok\r\n');
    expect(out).toContain('file: config.txt 8\n');
    expect(out).toContain('config: rate=10\n');
    expect(out).toContain('log: 21\nline 0\nline 1\nline 2\n');
    expect(out).toContain('done\r\n');
    const storage = bench.storage('sd')!;
    expect(storage.list().map((f) => f.path)).toEqual(['config.txt', 'log.txt', 'data', 'data/Long Name Readings.csv']);
    expect(utf8Text(storage.read('data/Long Name Readings.csv')!)).toBe('t,v\r\n0,512\r\n');
  }, 120_000);
});
