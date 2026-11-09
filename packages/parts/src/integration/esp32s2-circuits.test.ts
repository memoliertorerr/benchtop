import { Bench, type BenchEnv, NS_PER_MS, parseProject, type ProjectDoc, type VisualState } from '@benchtop/core';
import { esp32s2McuFactory } from '@benchtop/esp32s2';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedS2Rom } from '../../../esp32s2/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT150: BT149's ESP32-S2 fixtures on an ESP32-S2-DevKitM-1 on a full Bench — the factory the
// worker and the CLI use, with the cached ROM.

const ROM = loadCachedS2Rom();

function wire(id: string, a: string, ap: string, b: string, bp: string) {
  return { id, from: { part: a, pin: ap }, to: { part: b, pin: bp }, waypoints: [], color: 'green' };
}

function load(parts: ProjectDoc['parts'], wires: ReturnType<typeof wire>[], firmware: string) {
  const parsed = parseProject({ format: 1, name: 's2', parts: [{ id: 's2', type: 'esp32-s2-devkitm-1', x: 0, y: 0, rotation: 0, props: {} }, ...parts], wires, firmware: {} });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const env: BenchEnv = { part: benchEnvParts, createMcu: esp32s2McuFactory(ROM) };
  const bench = new Bench(parsed.doc, env);
  bench.attachFirmware('s2', { format: 'esp32-bin', app: readFixture(`fixtures/firmware/esp32s2/${firmware}.bin`), partitions: readFixture(`fixtures/firmware/esp32s2/${firmware}.partitions.bin`) });
  bench.reset();
  let text = '';
  bench.onSerial('s2', (bytes) => (text += String.fromCharCode(...bytes)));
  const latest = new Map<string, VisualState>();
  const runTo = (ms: number): void => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 5; t <= ms; t += 5) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) latest.set(part, structuredClone(visual));
    }
  };
  return { bench, serial: () => text, runTo, latest };
}

describe('ESP32-S2-DevKitM-1 on the bench (BT150)', () => {
  it('a button on IO41 counts presses through an interrupt and lights an LED on IO38', () => {
    const { bench, serial, runTo } = load(
      [
        { id: 'btn', type: 'pushbutton', x: -30, y: 10, rotation: 0, props: {} },
        { id: 'r1', type: 'resistor', x: 40, y: -14, rotation: 0, props: { ohms: 220 } },
        { id: 'led1', type: 'led', x: 36, y: -40, rotation: 0, props: {} },
      ],
      [wire('w1', 'btn', '1.l', 's2', 'IO41'), wire('w2', 'btn', '2.l', 's2', 'GND.2'), wire('w3', 's2', 'IO38', 'r1', '2'), wire('w4', 'r1', '1', 'led1', 'A'), wire('w5', 'led1', 'C', 's2', 'GND.1')],
      'gpio-interrupt',
    );
    runTo(400);
    expect(bench.pinState('led1', 'A')?.level).toBe(0);
    for (let i = 0; i < 3; i++) {
      bench.input('btn', { kind: 'press' });
      runTo(bench.now() / NS_PER_MS + 50);
      expect(bench.pinState('s2', 'IO38')?.level).toBe(1);
      bench.input('btn', { kind: 'release' });
      runTo(bench.now() / NS_PER_MS + 50);
      expect(bench.pinState('s2', 'IO38')?.level).toBe(0);
    }
    runTo(bench.now() / NS_PER_MS + 100);
    expect(serial()).toContain('count=3');
    expect(bench.mcuStopped('s2')).toBeNull();
    expect(bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('Wire on the default pins (IO8, IO9) finds a DS1307 and an SSD1306; Wire1 (IO39, IO40) its own LCD backpack', () => {
    const { serial, runTo } = load(
      [
        { id: 'rtc', type: 'ds1307', x: 40, y: 0, rotation: 0, props: {} },
        { id: 'oled', type: 'ssd1306', x: 40, y: 40, rotation: 0, props: { address: '0x3C' } },
        { id: 'lcd', type: 'lcd1602-i2c', x: -60, y: 40, rotation: 0, props: {} },
      ],
      [
        wire('w1', 's2', 'IO8', 'rtc', 'SDA'),
        wire('w2', 's2', 'IO9', 'rtc', 'SCL'),
        wire('w3', 'rtc', '5V', 's2', '3V3'),
        wire('w4', 'rtc', 'GND', 's2', 'GND.2'),
        wire('w5', 'oled', 'DATA', 's2', 'IO8'),
        wire('w6', 'oled', 'CLK', 's2', 'IO9'),
        wire('w7', 'oled', '3V3', 's2', '3V3'),
        wire('w8', 'oled', 'GND', 's2', 'GND.1'),
        wire('w9', 'lcd', 'SDA', 's2', 'IO39'),
        wire('w10', 'lcd', 'SCL', 's2', 'IO40'),
        wire('w11', 'lcd', 'VCC', 's2', '5V'),
        wire('w12', 'lcd', 'GND', 's2', 'GND.2'),
      ],
      'i2c-scan',
    );
    runTo(2600);
    expect(serial()).toContain('found 0x3C\nfound 0x68\nfound1 0x27\ndone\r\n');
    expect(serial()).toMatch(/sec=0[12]\n/);
  });

  it('the board’s RGB LED (WS2812 on GPIO18) shows rgb-blink’s colors in its visual state', () => {
    const { serial, runTo, latest } = load([], [], 'rgb-blink');
    const seen: number[] = [];
    for (let step = 0; step < 6; step++) {
      runTo(400 + step * 500);
      seen.push(((latest.get('s2')?.pixels as number[] | undefined) ?? [-1])[0]);
    }
    expect(serial()).toContain('step 4');
    // red, green, blue, LED_BUILTIN white at RGB_BRIGHTNESS 64, off, red again.
    expect(seen).toEqual([0xff0000, 0x00ff00, 0x0000ff, 0x404040, 0x000000, 0xff0000]);
  });

  it('a potentiometer on IO1 reads through the 13-bit ADC1 at 11 dB', () => {
    const { bench, serial, runTo } = load(
      [{ id: 'pot', type: 'potentiometer', x: -40, y: 0, rotation: 0, props: {} }],
      [wire('w1', 'pot', 'SIG', 's2', 'IO1'), wire('w2', 'pot', 'VCC', 's2', '3V3'), wire('w3', 'pot', 'GND', 's2', 'GND.1')],
      'adc-read',
    );
    bench.input('pot', { kind: 'value', value: 0.5 });
    runTo(600);
    const line = serial().split('\n').filter((l) => l.startsWith('a=')).at(-1) ?? '';
    // 1.65 V of 2.5 V at 13 bits: 5406 (±4 for the pot's divider and rounding).
    const a = Number(/^a=(\d+)/.exec(line)?.[1]);
    expect(Math.abs(a - 5406)).toBeLessThanOrEqual(4);
  });

  it('a CDC-on-boot build talks over the S2\'s own USB: the bench\'s host enumerates it, the serial monitor shows it beside UART0', () => {
    const { bench, serial, runTo } = load([], [], 'usb-cdc');
    runTo(1300);
    expect(serial()).toContain('uart0 here\r\n');
    expect(serial()).toContain('usb cdc up baud 115200\n');
    expect(serial()).toContain('tick 1\n');
    expect(bench.usbOf('s2')?.device).toBe('ESP32S2_DEV');
    expect(bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('the USB 5 V reaches the 5V pin; without a ROM the board says how to get it', () => {
    const parsed = parseProject({ format: 1, name: 's2', parts: [{ id: 's2', type: 'esp32-s2-devkitm-1', x: 0, y: 0, rotation: 0, props: {} }], wires: [], firmware: {} });
    if (!parsed.ok) throw new Error('bad');
    const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: esp32s2McuFactory(undefined) });
    bench.attachFirmware('s2', { format: 'esp32-bin', app: readFixture('fixtures/firmware/esp32s2/serial-hello.bin') });
    bench.reset();
    expect(bench.pinState('s2', '5V')?.volts).toBeCloseTo(5);
    expect(bench.pinState('s2', '3V3')?.volts).toBeCloseTo(3.3);
    expect(bench.problems().map((p) => p.code)).toContain('esp32s2-rom-missing');
  });
});
