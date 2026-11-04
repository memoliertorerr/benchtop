import { avrMcuFactory } from '@benchtop/avr';
import { assembleBench, type Bench, type BenchEnv, type FirmwareImage, type Mcu, NS_PER_MS, type NvMemory, type ProjectDoc, usesNonVolatile } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { esp32c3McuFactory } from '@benchtop/esp32c3';
import { rp2040McuFactory } from '@benchtop/rp2040';
import { rp2350McuFactory } from '@benchtop/rp2350';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { loadCachedC3Rom } from '../../../esp32c3/src/test-support/rom.test-helper.ts';
import { cachedRom as cachedRp2350Rom } from '../../../rp2350/src/rp2350.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT118: non-volatile memory that keeps its contents — a boot counter on each board (the Uno's
// EEPROM, the ESP32s' Preferences/NVS, the Picos' EEPROM emulation in flash) counts on across a
// board reset, a bench reset, a reload of the same firmware and (the ESP32s) ESP.restart(); a
// snapshot restored on a fresh bench goes on from there; an erase starts it again.

const esp32 = esp32McuFactory(loadCachedRom());
const c3 = esp32c3McuFactory(loadCachedC3Rom());
const rp2350Rom = cachedRp2350Rom();

interface Board {
  type: string;
  image: () => FirmwareImage;
  /** The MCU UART the counter prints on (the Picos' Serial1 is UART0, the MCU's port 1; port 0 is USB). */
  port: number;
  /** Lines "boot <n>" by `ms` of a start (the ESP32s boot slower). */
  bootMs: number;
}

const BOARDS: Record<string, Board> = {
  uno: { type: 'arduino-uno', image: () => ({ format: 'hex', text: readFixtureText('fixtures/firmware/uno/eeprom-counter.hex') }), port: 0, bootMs: 100 },
  esp32: { type: 'esp32-devkit-v1', image: () => esp32Image('esp32', 'prefs-counter'), port: 0, bootMs: 800 },
  esp32c3: { type: 'esp32-c3-devkitm-1', image: () => esp32Image('esp32c3', 'prefs-counter'), port: 0, bootMs: 800 },
  pico: { type: 'raspberry-pi-pico', image: () => ({ format: 'uf2', bytes: readFixture('fixtures/firmware/pico/eeprom-counter.uf2') }), port: 1, bootMs: 400 },
  pico2: { type: 'raspberry-pi-pico-2', image: () => ({ format: 'uf2', bytes: readFixture('fixtures/firmware/pico2/eeprom.uf2') }), port: 1, bootMs: 400 },
};

function esp32Image(board: string, name: string): FirmwareImage {
  return { format: 'esp32-bin', app: readFixture(`fixtures/firmware/${board}/${name}.bin`), partitions: readFixture(`fixtures/firmware/${board}/${name}.partitions.bin`) };
}

const env: BenchEnv = {
  part: benchEnvParts,
  createMcu: (board, id, report) => {
    if (board.mcu === 'esp32') return esp32(board, id, report);
    if (board.mcu === 'esp32c3') return c3(board, id, report);
    if (board.mcu === 'rp2040') return rp2040McuFactory(board, id, report);
    if (board.mcu === 'rp2350') return rp2350McuFactory(board, id, report, { rom: rp2350Rom });
    return avrMcuFactory(board);
  },
};

function doc(boards: readonly [string, string][]): ProjectDoc {
  return { format: 1, name: 'nonvolatile', parts: boards.map(([id, type], i) => ({ id, type, x: i * 100, y: 0, rotation: 0, props: {} })), wires: [], firmware: {} } as unknown as ProjectDoc;
}

/** A bench with one board of `kind` as "b", its counter's lines collected from the MCU's UART. */
function rig(kind: string) {
  const board = BOARDS[kind];
  const bench = assembleBench(doc([['b', board.type]]), env, { b: board.image() });
  return watch(bench, kind);
}

function watch(bench: Bench, kind: string) {
  const board = BOARDS[kind];
  const mcu = (bench as unknown as { mcus: { partId: string; mcu: Mcu }[] }).mcus.find((m) => m.partId === 'b')!.mcu;
  let text = '';
  mcu.uart(board.port)?.onTransmit((byte) => (text += String.fromCharCode(byte)));
  const counts = (): number[] => [...text.matchAll(/^boot (\d+)/gm)].map((m) => Number(m[1]));
  const run = (ms: number): void => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 10, end = bench.now() / NS_PER_MS + ms; t <= end; t += 10) bench.runUntil(t * NS_PER_MS);
  };
  if (!usesNonVolatile(mcu)) throw new Error(`${kind} has no non-volatile memory`);
  const nvm = (): NvMemory => {
    const memory = mcu.nonVolatile();
    if (memory === null) throw new Error(`${kind}: no memory yet`);
    return memory;
  };
  return { bench, mcu, counts, run, nvm, send: (line: string) => bench.sendSerial('b', Uint8Array.from([...`${line}\n`].map((c) => c.charCodeAt(0)))) };
}

/** The Pico 2's fixture (BT65) prints the count it read (0 first); the others the count they store (1 first). */
const first = (kind: string): number => (kind === 'pico2' ? 0 : 1);

describe('non-volatile memory keeps its contents (BT118)', () => {
  for (const kind of Object.keys(BOARDS)) {
    it(`${kind}: the boot counter counts on across a board reset, a bench reset and a reload; a snapshot restored on a fresh bench goes on; an erase starts again`, () => {
      const board = BOARDS[kind];
      const f = first(kind);
      const r = rig(kind);
      expect(r.nvm().snapshot()).toEqual([]); // nothing stored before the firmware ran
      r.run(board.bootMs);
      expect(r.counts()).toEqual([f]);
      r.bench.resetBoard('b');
      r.run(board.bootMs);
      r.bench.reset();
      r.run(board.bootMs);
      r.bench.attachFirmware('b', board.image()); // an upload of the same sketch
      r.run(board.bootMs);
      expect(r.counts()).toEqual([f, f + 1, f + 2, f + 3]);
      // What it stored, as a host keeps it: a sector or two, none of the program's.
      const saved = r.nvm().snapshot();
      expect(saved.length).toBeGreaterThan(0);
      expect(saved.length).toBeLessThanOrEqual(4);
      for (const sector of saved) expect(sector.bytes.length).toBe(r.nvm().sectorSize);
      // A fresh bench (another session) with the snapshot put back.
      const fresh = rig(kind);
      expect(fresh.nvm().restore(saved)).toBe(saved.length);
      fresh.bench.resetBoard('b');
      fresh.run(board.bootMs);
      expect(fresh.counts().at(-1)).toBe(f + 4);
      // Erased: the program stays, the count starts again.
      fresh.nvm().erase();
      expect(fresh.nvm().snapshot()).toEqual([]);
      fresh.bench.resetBoard('b');
      fresh.run(board.bootMs);
      expect(fresh.counts().at(-1)).toBe(f);
    }, 60_000);
  }

  for (const kind of ['esp32', 'esp32c3']) {
    it(`${kind}: ESP.restart() keeps NVS too; Preferences.clear() empties the namespace`, () => {
      const r = rig(kind);
      r.run(800);
      r.send('restart');
      r.run(1200);
      expect(r.counts()).toEqual([1, 2]);
      r.send('clear');
      r.run(200);
      r.bench.resetBoard('b');
      r.run(800);
      expect(r.counts()).toEqual([1, 2, 1]);
    }, 60_000);
  }

  it('Bench.resetBoard resets one board and leaves the other running', () => {
    const bench = assembleBench(doc([['a', 'arduino-uno'], ['b', 'arduino-uno']]), env, { a: BOARDS.uno.image(), b: BOARDS.uno.image() });
    const lines: Record<string, string> = { a: '', b: '' };
    for (const id of ['a', 'b']) bench.onSerial(id, (bytes) => (lines[id] += String.fromCharCode(...bytes)));
    for (let t = 10; t <= 200; t += 10) bench.runUntil(t * NS_PER_MS);
    expect([lines.a, lines.b]).toEqual(['boot 1\r\n', 'boot 1\r\n']);
    bench.resetBoard('a');
    for (let t = 210; t <= 400; t += 10) bench.runUntil(t * NS_PER_MS);
    expect([lines.a, lines.b]).toEqual(['boot 1\r\nboot 2\r\n', 'boot 1\r\n']);
    expect(bench.now()).toBe(400 * NS_PER_MS);
  });

  it('restore() skips what it can’t take: off the memory, misaligned, the wrong size, over the program', () => {
    const r = rig('pico');
    const nvm = r.nvm();
    const size = nvm.sectorSize;
    const good = new Uint8Array(size).fill(1);
    expect(nvm.restore([
      { offset: nvm.size, bytes: good },
      { offset: size + 1, bytes: good },
      { offset: nvm.size - size, bytes: new Uint8Array(3) },
      { offset: 0, bytes: good }, // the image's first sector
      { offset: nvm.size - size, bytes: good },
    ])).toBe(1);
    expect(nvm.read(nvm.size - size, 4)).toEqual(Uint8Array.of(1, 1, 1, 1));
    expect(nvm.read(0, 4)).not.toEqual(Uint8Array.of(1, 1, 1, 1));
  });
});
