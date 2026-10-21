import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, NS_PER_MS, NS_PER_US, parseProject } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT39: an Uno and an ESP32 on one bench, talking over a UART. uno/uart-ping sends "ping\n" every
// 100 ms at 115200 baud from D1; esp32/uart-relay copies what Serial2 (RX2 = GPIO16) receives to
// its UART0.

const ROM = loadCachedRom();

function load(project: string) {
  const parsed = parseProject(JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const esp32 = esp32McuFactory(ROM);
  const env: BenchEnv = { part: benchEnvParts, createMcu: (board, id, report) => avrMcuFactory(board) ?? esp32(board, id, report) };
  const bench = new Bench(parsed.doc, env);
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText('fixtures/firmware/uno/uart-ping.hex') });
  bench.attachFirmware('esp', {
    format: 'esp32-bin',
    app: readFixture('fixtures/firmware/esp32/uart-relay.bin'),
    partitions: readFixture('fixtures/firmware/esp32/uart-relay.partitions.bin'),
  });
  bench.reset();
  const out = { uno: '', esp: '' };
  bench.onSerial('uno', (bytes) => (out.uno += String.fromCharCode(...bytes)));
  bench.onSerial('esp', (bytes) => (out.esp += String.fromCharCode(...bytes)));
  return { bench, out };
}

const pings = (text: string): number => text.split('ping').length - 1;

describe('two boards on one bench (BT39)', () => {
  it('Uno → ESP32 over a wire: the ESP32 relays every ping within 1 s; bytes cross in ≤ one quantum; 5 V on the ESP32 pin is an error', () => {
    const { bench, out } = load('uno-esp32-uart');
    expect(bench.quantum).toBe(100 * NS_PER_US);
    // When each Uno byte is reported (its frame starts) and when the ESP32's UART2 is handed it.
    const sent: number[] = [];
    const handed: number[] = [];
    const uno = (bench as unknown as { mcuSlot(id: string): { mcu: import('@benchtop/core').Mcu } }).mcuSlot('uno').mcu;
    const esp = (bench as unknown as { mcuSlot(id: string): { mcu: import('@benchtop/core').Mcu } }).mcuSlot('esp').mcu;
    uno.uart(0)!.onTransmit(() => sent.push(bench.now()));
    const uart2 = esp.uart(2)!;
    const receive = uart2.receive.bind(uart2);
    uart2.receive = (bytes) => {
      handed.push(bench.now());
      receive(bytes);
    };
    const started = performance.now();
    for (let t = 10; t <= 1000; t += 10) bench.runUntil(t * NS_PER_MS);
    const wall = (performance.now() - started) / 1000;
    expect(bench.mcuStopped('uno')).toBeNull();
    expect(bench.mcuStopped('esp')).toBeNull();
    expect(pings(out.uno)).toBeGreaterThanOrEqual(10);
    expect(pings(out.esp)).toBeGreaterThanOrEqual(9);
    expect(out.esp).toMatch(/^(?:ping\n)+(?:p(?:i(?:n(?:g)?)?)?)?$/);
    // Every byte the ESP32 got was handed over 0 … 1 quantum after the Uno reported it; the
    // ESP32's UART then frames it (10 bit-times at 115 200 baud, BT35's model).
    expect(handed.length).toBeGreaterThan(0);
    const offset = sent.length - handed.length; // bytes sent before the ESP32's Serial2 listened
    handed.forEach((t, i) => {
      const latency = t - sent[i + offset];
      expect(latency).toBeGreaterThanOrEqual(0);
      expect(latency).toBeLessThanOrEqual(100 * NS_PER_US);
    });
    expect(esp.uart(2)!.baud?.()).toBeCloseTo(115200, -2);
    expect(uno.uart(0)!.baud?.()).toBeGreaterThan(110_000);
    const problems = bench.problems();
    expect(problems.some((p) => p.code === 'esp32-overvoltage' && p.severity === 'error')).toBe(true);
    expect(problems.some((p) => p.code === 'uart-baud-mismatch')).toBe(false);
    console.info(`uno ↔ esp32 UART: ${pings(out.esp)} pings relayed in 1 s simulated, ${wall.toFixed(2)} s wall`);
  }, 120_000);

  it('through a 1 kΩ / 2 kΩ divider: the bytes still cross and the ESP32 pin stays at 3.3 V', () => {
    const { bench, out } = load('uno-esp32-uart-divider');
    for (let t = 10; t <= 600; t += 10) bench.runUntil(t * NS_PER_MS);
    expect(pings(out.esp)).toBeGreaterThanOrEqual(4);
    expect(bench.problems().filter((p) => p.code === 'esp32-overvoltage')).toEqual([]);
  }, 120_000);
});
