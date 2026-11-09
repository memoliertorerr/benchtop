import { Bench, type BenchEnv, NS_PER_MS, parseProject, type ProjectDoc } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { esp32s2McuFactory } from '@benchtop/esp32s2';
import { esp32s3McuFactory } from '@benchtop/esp32s3';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { loadCachedS2Rom } from '../../../esp32s2/src/test-support/rom.test-helper.ts';
import { loadCachedS3Rom } from '../../../esp32s3/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT136: the pins a board's module takes — a WROVER-E's GPIO16/17 (the DevKit V1's RX2/TX2), an
// N8R8's GPIO33–37 (the DevKitC-1's IO35–37), or those of a build that brought PSRAM up on `auto`:
// a wire from one to another part is a `pin-reserved` warning from the bench's dynamic checks.

const esp32 = esp32McuFactory(loadCachedRom());
const esp32s3 = esp32s3McuFactory(loadCachedS3Rom());
const esp32s2 = esp32s2McuFactory(loadCachedS2Rom());
const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report, props) => esp32(board, id, report, props) ?? esp32s3(board, id, report, props) ?? esp32s2(board, id, report, props) };

/** A board (`b`) with `module`, an LED from `header` to GND, or only a breadboard strip there. */
function bench(type: 'esp32-devkit-v1' | 'esp32-s3-devkitc-1' | 'esp32-s2-devkitm-1', module: string, header: string, firmware: string | null, breadboardOnly = false): Bench {
  const doc: ProjectDoc = {
    format: 1,
    name: 'module-pins',
    parts: [
      { id: 'b', type, x: 0, y: 0, rotation: 0, props: { module } },
      breadboardOnly ? { id: 'bb', type: 'breadboard-half', x: 80, y: 0, rotation: 0, props: {} } : { id: 'led1', type: 'led', x: 80, y: 0, rotation: 0, props: {} },
    ],
    wires: breadboardOnly
      ? [{ id: 'w1', from: { part: 'b', pin: header }, to: { part: 'bb', pin: '5t.a' }, waypoints: [], color: 'green' }]
      : [
          { id: 'w1', from: { part: 'b', pin: header }, to: { part: 'led1', pin: 'A' }, waypoints: [], color: 'green' },
          { id: 'w2', from: { part: 'b', pin: 'GND.1' }, to: { part: 'led1', pin: 'C' }, waypoints: [], color: 'black' },
        ],
    firmware: {},
  } as ProjectDoc;
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const created = new Bench(parsed.doc, env);
  if (firmware !== null) {
    const dir = type === 'esp32-devkit-v1' ? 'esp32' : type === 'esp32-s3-devkitc-1' ? 'esp32s3' : 'esp32s2';
    created.attachFirmware('b', { format: 'esp32-bin', app: readFixture(`fixtures/firmware/${dir}/${firmware}.bin`), partitions: readFixture(`fixtures/firmware/${dir}/${firmware}.partitions.bin`) });
  }
  created.reset();
  return created;
}

const reserved = (b: Bench) => b.problems().filter((p) => p.code === 'pin-reserved');

describe('the pins a module takes (BT136)', () => {
  it('a WROVER-E: a wire from RX2 or TX2 to a part is a warning naming the header, the GPIO and the PSRAM, before any firmware runs', () => {
    for (const [header, gpio, role] of [
      ['RX2', 'GPIO16', 'chip select'],
      ['TX2', 'GPIO17', 'clock'],
    ]) {
      const b = bench('esp32-devkit-v1', 'WROVER-E', header, null);
      b.runUntil(20 * NS_PER_MS);
      const found = reserved(b);
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].message).toContain(`b:${header} is wired to led1`);
      expect(found[0].message).toContain(`${gpio} is the WROVER-E module's PSRAM ${role}`);
      expect(found[0].message).toContain("Serial2's default");
      expect(found[0].parts).toEqual(['b', 'led1']);
    }
  });

  it('a WROOM-32 holds nothing; a strip of a breadboard with nothing else on it is not a part', () => {
    const wroom = bench('esp32-devkit-v1', 'WROOM-32', 'RX2', 'psram');
    wroom.runUntil(400 * NS_PER_MS);
    expect(reserved(wroom)).toEqual([]);
    const strip = bench('esp32-devkit-v1', 'WROVER-E', 'RX2', null, true);
    strip.runUntil(20 * NS_PER_MS);
    expect(reserved(strip)).toEqual([]);
  });

  it('auto: a build that brings PSRAM up gets the same warning (the MCU tests show when it starts); a build without PSRAM never', () => {
    const psram = bench('esp32-devkit-v1', 'auto', 'TX2', 'psram');
    psram.runUntil(400 * NS_PER_MS);
    const found = reserved(psram);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("GPIO17 is the PSRAM's clock (this build uses PSRAM, as on a WROVER)");
    const plain = bench('esp32-devkit-v1', 'auto', 'TX2', 'serial-hello');
    plain.runUntil(400 * NS_PER_MS);
    expect(reserved(plain)).toEqual([]);
  });

  it('an N8R8: IO35–37 are its octal PSRAM’s; an N8R2 (quad, on GPIO26) and an N8 hold none of the header’s pins', () => {
    for (const [header, role] of [
      ['IO35', 'SPIIO6'],
      ['IO36', 'SPIIO7'],
      ['IO37', 'SPIDQS'],
    ]) {
      const b = bench('esp32-s3-devkitc-1', 'N8R8', header, null);
      b.runUntil(20 * NS_PER_MS);
      const found = reserved(b);
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain(`b:${header} is wired to led1, but GPIO${header.slice(2)} is the N8R8 module's octal PSRAM (${role})`);
    }
    for (const module of ['N8R2', 'N8']) {
      const b = bench('esp32-s3-devkitc-1', module, 'IO35', null);
      b.runUntil(20 * NS_PER_MS);
      expect(reserved(b)).toEqual([]);
    }
  });

  it('auto on the S3: an octal build claims IO35–37 once its PSRAM runs, a quad build doesn’t', () => {
    const octal = bench('esp32-s3-devkitc-1', 'auto', 'IO36', 'psram-octal');
    octal.runUntil(500 * NS_PER_MS);
    const found = reserved(octal);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("GPIO36 is the octal PSRAM's SPIIO7 (this build uses it, as on an N8R8)");
    const quad = bench('esp32-s3-devkitc-1', 'auto', 'IO36', 'psram-quad');
    quad.runUntil(500 * NS_PER_MS);
    expect(reserved(quad)).toEqual([]);
  });

  it('BT154: an S2 N4R2 holds IO26 (its PSRAM’s chip select); an N4 none; auto once a PSRAM build runs', () => {
    const r2 = bench('esp32-s2-devkitm-1', 'N4R2', 'IO26', null);
    r2.runUntil(20 * NS_PER_MS);
    const found = reserved(r2);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("b:IO26 is wired to led1, but GPIO26 is the N4R2 module's PSRAM (its chip select, SPICS1)");
    const n4 = bench('esp32-s2-devkitm-1', 'N4', 'IO26', 'psram');
    n4.runUntil(400 * NS_PER_MS);
    expect(reserved(n4)).toEqual([]);
    const auto = bench('esp32-s2-devkitm-1', 'auto', 'IO26', 'psram');
    auto.runUntil(400 * NS_PER_MS);
    expect(reserved(auto).map((p) => p.message).join()).toContain("GPIO26 is the PSRAM's chip select (this build uses PSRAM, as on an N4R2 module)");
    const plain = bench('esp32-s2-devkitm-1', 'auto', 'IO26', 'serial-hello');
    plain.runUntil(400 * NS_PER_MS);
    expect(reserved(plain)).toEqual([]);
  });
});
