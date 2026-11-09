import { Bench, type BenchEnv, type Mcu, NS_PER_MS, parseProject, type ProjectDoc, SymbolTable } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { esp32s3McuFactory } from '@benchtop/esp32s3';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { loadCachedS3Rom } from '../../../esp32s3/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { netSpecFor } from '../network/specs.ts';

// BT163: ADC2 and WiFi. On an ESP32, ESP-IDF's WiFi start takes the ADC driver's ADC2 lock, so
// analogRead on an ADC2 pin returns 0 until WiFi stops; the simulated WiFi driver takes and gives
// back the same lock (the firmware's own adc2_wifi_acquire/release). On the S3 that lock is a no-op
// in IDF 4.4 (a hardware arbiter decides per conversion, with WiFi's power detection, which the
// bench doesn't simulate): its reads go on working. A pot at mid-travel holds the pin at 1.65 V.

const esp32 = esp32McuFactory(loadCachedRom());
const esp32s3 = esp32s3McuFactory(loadCachedS3Rom());

function run(chip: 'esp32' | 's3') {
  const board = chip === 'esp32' ? { type: 'esp32-devkit-v1', id: 'esp', dir: 'esp32', pin: 'D4', supply: '3V3', gnd: 'GND.1' } : { type: 'esp32-s3-devkitc-1', id: 's3', dir: 'esp32s3', pin: 'IO11', supply: '3V3.1', gnd: 'GND.1' };
  const doc = {
    format: 1,
    name: 'adc2-wifi',
    parts: [
      { id: board.id, type: board.type, x: 0, y: 0, rotation: 0, props: {} },
      { id: 'pot', type: 'potentiometer', x: -40, y: 10, rotation: 0, props: { value: 0.5 } },
    ],
    wires: [
      { id: 'w1', from: { part: 'pot', pin: 'SIG' }, to: { part: board.id, pin: board.pin }, waypoints: [], color: 'green' },
      { id: 'w2', from: { part: 'pot', pin: 'VCC' }, to: { part: board.id, pin: board.supply }, waypoints: [], color: 'red' },
      { id: 'w3', from: { part: 'pot', pin: 'GND' }, to: { part: board.id, pin: board.gnd }, waypoints: [], color: 'black' },
    ],
    firmware: {},
  } as ProjectDoc;
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const symbols = SymbolTable.fromNm(readFixtureText(`fixtures/firmware/${board.dir}/adc2-wifi.syms.tsv`));
  const env: BenchEnv = {
    part: benchEnvParts,
    createMcu: (spec, id, report, props) => {
      const mcu = (chip === 'esp32' ? esp32(spec, id, report, props) : esp32s3(spec, id, report, props)) as (Mcu & { useSymbols(table: SymbolTable): void }) | undefined;
      mcu?.useSymbols(symbols);
      return mcu;
    },
  };
  const bench = new Bench(parsed.doc, env, { netSpecFor });
  bench.attachFirmware(board.id, { format: 'esp32-bin', app: readFixture(`fixtures/firmware/${board.dir}/adc2-wifi.bin`), partitions: readFixture(`fixtures/firmware/${board.dir}/adc2-wifi.partitions.bin`) });
  bench.reset();
  let text = '';
  bench.onSerial(board.id, (bytes) => (text += String.fromCharCode(...bytes)));
  for (let t = 10; t <= 2000 && !text.includes('after'); t += 10) bench.runUntil(t * NS_PER_MS);
  bench.runUntil(bench.now() + 20 * NS_PER_MS);
  const value = (label: string): number => Number(new RegExp(`${label} (\\d+)`).exec(text)?.[1] ?? Number.NaN);
  return { before: value('before'), during: value('with wifi'), after: value('after'), text };
}

describe('ADC2 and WiFi (BT163)', () => {
  it('ESP32: an ADC2 read works before WiFi starts, returns 0 while it runs (IDF’s lock), and works again after it stops', () => {
    const r = run('esp32');
    expect(Math.abs(r.before - 2048), r.text).toBeLessThanOrEqual(40);
    expect(r.during).toBe(0);
    expect(Math.abs(r.after - 2048)).toBeLessThanOrEqual(40);
  }, 60_000);

  it('ESP32-S3: IDF 4.4’s lock is a no-op there, so its ADC2 reads go on working with WiFi', () => {
    const r = run('s3');
    expect(Math.abs(r.before - Math.round((1.65 / 3.1) * 4095)), r.text).toBeLessThanOrEqual(40); // the S3's 11 dB range: 3.1 V
    for (const v of [r.during, r.after]) expect(Math.abs(v - r.before), r.text).toBeLessThanOrEqual(5);
  }, 60_000);
});
