import { Bench, type BenchEnv, NS_PER_MS, parseProject, type ProjectDoc } from '@benchtop/core';
import { esp32c3McuFactory } from '@benchtop/esp32c3';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedC3Rom } from '../../../esp32c3/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT94: BT93's ESP32-C3 fixtures on an ESP32-C3-DevKitM-1 on a full Bench — the factory the
// worker and the CLI use, with the cached ROM.

const ROM = loadCachedC3Rom();

function wire(id: string, a: string, ap: string, b: string, bp: string) {
  return { id, from: { part: a, pin: ap }, to: { part: b, pin: bp }, waypoints: [], color: 'green' };
}

function load(parts: ProjectDoc['parts'], wires: ReturnType<typeof wire>[], firmware: string) {
  const parsed = parseProject({ format: 1, name: 'c3', parts: [{ id: 'c3', type: 'esp32-c3-devkitm-1', x: 0, y: 0, rotation: 0, props: {} }, ...parts], wires, firmware: {} });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const env: BenchEnv = { part: benchEnvParts, createMcu: esp32c3McuFactory(ROM) };
  const bench = new Bench(parsed.doc, env);
  bench.attachFirmware('c3', { format: 'esp32-bin', app: readFixture(`fixtures/firmware/esp32c3/${firmware}.bin`), partitions: readFixture(`fixtures/firmware/esp32c3/${firmware}.partitions.bin`) });
  bench.reset();
  let text = '';
  bench.onSerial('c3', (bytes) => (text += String.fromCharCode(...bytes)));
  return { bench, serial: () => text };
}

const runTo = (bench: Bench, ms: number): void => {
  for (let t = Math.floor(bench.now() / NS_PER_MS) + 5; t <= ms; t += 5) bench.runUntil(t * NS_PER_MS);
};

describe('ESP32-C3-DevKitM-1 on the bench (BT94)', () => {
  it('a button on IO9 counts presses through an interrupt and lights an LED on IO3', () => {
    const { bench, serial } = load(
      [
        { id: 'btn', type: 'pushbutton', x: -30, y: 10, rotation: 0, props: {} },
        { id: 'r1', type: 'resistor', x: 40, y: -14, rotation: 0, props: { ohms: 220 } },
        { id: 'led1', type: 'led', x: 36, y: -40, rotation: 0, props: {} },
      ],
      [wire('w1', 'btn', '1.l', 'c3', 'IO9'), wire('w2', 'btn', '2.l', 'c3', 'GND.6'), wire('w3', 'c3', 'IO3', 'r1', '2'), wire('w4', 'r1', '1', 'led1', 'A'), wire('w5', 'led1', 'C', 'c3', 'GND.2')],
      'gpio-interrupt',
    );
    runTo(bench, 300);
    expect(bench.pinState('led1', 'A')?.level).toBe(0);
    for (let i = 0; i < 3; i++) {
      bench.input('btn', { kind: 'press' });
      runTo(bench, bench.now() / NS_PER_MS + 50);
      expect(bench.pinState('c3', 'IO3')?.level).toBe(1);
      bench.input('btn', { kind: 'release' });
      runTo(bench, bench.now() / NS_PER_MS + 50);
      expect(bench.pinState('c3', 'IO3')?.level).toBe(0);
    }
    runTo(bench, bench.now() / NS_PER_MS + 100);
    expect(serial()).toContain('count=3');
    expect(bench.mcuStopped('c3')).toBeNull();
  });

  it('Wire on the default pins (IO8, IO9) finds an SSD1306 and a DS1307', () => {
    const { bench, serial } = load(
      [
        { id: 'rtc', type: 'ds1307', x: 40, y: 0, rotation: 0, props: {} },
        { id: 'oled', type: 'ssd1306', x: 40, y: 40, rotation: 0, props: { address: '0x3C' } },
      ],
      [wire('w1', 'c3', 'IO8', 'rtc', 'SDA'), wire('w2', 'c3', 'IO9', 'rtc', 'SCL'), wire('w3', 'rtc', '5V', 'c3', '3V3.1'), wire('w4', 'rtc', 'GND', 'c3', 'GND.6'), wire('w5', 'oled', 'DATA', 'c3', 'IO8'), wire('w6', 'oled', 'CLK', 'c3', 'IO9'), wire('w7', 'oled', '3V3', 'c3', '3V3.2'), wire('w8', 'oled', 'GND', 'c3', 'GND.7')],
      'i2c-scan',
    );
    runTo(bench, 1500);
    expect(serial()).toContain('found 0x3C\nfound 0x68\ndone\r\n');
  });

  it('the USB 5 V reaches the 5V pins; without a ROM the board says how to get it', () => {
    const parsed = parseProject({ format: 1, name: 'c3', parts: [{ id: 'c3', type: 'esp32-c3-devkitm-1', x: 0, y: 0, rotation: 0, props: {} }], wires: [], firmware: {} });
    if (!parsed.ok) throw new Error('bad');
    const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: esp32c3McuFactory(undefined) });
    bench.attachFirmware('c3', { format: 'esp32-bin', app: readFixture('fixtures/firmware/esp32c3/serial-hello.bin') });
    bench.reset();
    expect(bench.pinState('c3', '5V.2')?.volts).toBeCloseTo(5);
    expect(bench.problems().map((p) => p.code)).toContain('esp32c3-rom-missing');
  });
});
