import type { NetState } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { createEsp32Mcu, type Esp32Mcu } from '../esp32.ts';
import { REF_HZ } from '../soc/context.ts';
import { loadCachedRom } from '../test-support/rom.test-helper.ts';

// BT35: UART RX, LEDC PWM and ADC1 with real Arduino-ESP32 firmware, through the Mcu adapter
// (pins and UART ports as the bench sees them).

const ROM = loadCachedRom();
const MS = REF_HZ / 1000;

function boot(fixture: string): { mcu: Esp32Mcu; out: string[]; times: number[][]; run: (ms: number) => void } {
  const mcu = createEsp32Mcu({ rom: ROM });
  mcu.load({
    format: 'esp32-bin',
    app: readFixture(`fixtures/firmware/esp32/${fixture}.bin`),
    partitions: readFixture(`fixtures/firmware/esp32/${fixture}.partitions.bin`),
  });
  const out = ['', '', ''];
  const times: number[][] = [[], [], []];
  for (let i = 0; i < 3; i++) {
    mcu.uart(i)!.onTransmit((byte) => {
      out[i] += String.fromCharCode(byte);
      times[i].push(mcu.cycles);
    });
  }
  const run = (ms: number): void => {
    const result = mcu.runUntil(mcu.cycles + ms * MS);
    if (result.reason !== 'target') throw new Error(`stopped: ${result.detail}`);
  };
  return { mcu, out, times, run };
}

const volts = (v: number): NetState => ({ level: v >= 1.65 ? 1 : 0, strength: 2, conflict: false, volts: v });
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('UART RX on real firmware (BT35)', () => {
  it('serial-echo: "abc\\n" comes back as "> ABC\\r\\n", no earlier than the line allows; 200 bytes arrive intact; Serial2 echoes too', () => {
    const { mcu, out, times, run } = boot('serial-echo');
    for (let i = 0; i < 60 && !out[0].includes('ready\r\n'); i++) run(10);
    expect(out[0]).toBe('ready\r\n');
    const t0 = mcu.cycles;
    mcu.uart(0)!.receive(ascii('abc\n'));
    run(10);
    expect(out[0]).toBe('ready\r\n> ABC\r\n');
    // 4 bytes in, then the reply's first byte out: at least 5 frames of 86.8 µs (115 200 baud,
    // 10 bits a byte) after the bytes were sent.
    const firstEcho = times[0][7];
    expect((firstEcho - t0) / REF_HZ).toBeGreaterThanOrEqual(5 * (10 / 115200) * 0.999);
    // A 200-byte line: more than the 128-byte FIFO; the driver drains it on RXFIFO_FULL/TOUT.
    const line = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    mcu.uart(0)!.receive(ascii(`${line}\n`));
    run(60);
    expect(out[0]).toBe(`ready\r\n> ABC\r\n> ${line.toUpperCase()}\r\n`);
    // Serial2: UART2, its TX on GPIO17 through the GPIO matrix.
    mcu.uart(2)!.receive(ascii('hello\n'));
    run(10);
    expect(out[2]).toBe('> HELLO\r\n');
    expect(mcu.pins.get('GPIO17')!.mode()).toBe('peripheral');
    expect(mcu.soc.problems.problems.filter((p) => p.code === 'esp32-uart-rx-overflow')).toEqual([]);
  }, 60_000);
});

describe('LEDC PWM on real firmware (BT35)', () => {
  it('ledc-fade: analogWrite(2, 64) is 1 kHz at 25 %, ledcWrite on D4 is 5 kHz at 50 %, and ledcWrite duty changes land on period boundaries', () => {
    const { mcu, out, run } = boot('ledc-fade');
    const edges: Record<number, [number, number][]> = { 2: [], 4: [] };
    for (const g of [2, 4]) {
      const pin = mcu.pins.get(`GPIO${g}`)!;
      pin.onOutputChange(() => {
        const list = edges[g];
        const level = pin.outputLevel();
        if (list.length === 0 || list[list.length - 1][1] !== level) list.push([mcu.cycles, level]);
      });
    }
    for (let i = 0; i < 60 && !out[0].includes('ready'); i++) run(10);
    const ready = mcu.cycles;
    run(2600);
    expect(mcu.pins.get('GPIO2')!.mode()).toBe('peripheral');
    const rises = (g: number): number[] => edges[g].filter(([t, l]) => l === 1 && t > ready).map(([t]) => t);
    const highs = (g: number): [number, number][] =>
      edges[g].flatMap(([t, l], i) => (l === 1 && t > ready && i + 1 < edges[g].length ? [[t, edges[g][i + 1][0] - t] as [number, number]] : []));
    // GPIO2: 1 kHz, 25 % — every period.
    const r2 = rises(2);
    expect(r2.length).toBeGreaterThan(2500);
    for (let i = 1; i < r2.length; i++) expect(Math.abs((r2[i] - r2[i - 1]) / MS - 1)).toBeLessThan(0.001);
    for (const [, h] of highs(2)) expect(Math.abs(h / MS - 0.25)).toBeLessThan(0.005);
    // D4: 5 kHz; 50 % for the first second, then 25 % / 50 % — every rise exactly a period
    // apart through the changes, and every high time a whole 25 % or 50 % (no partial period).
    const r4 = rises(4);
    const period = REF_HZ / 5000;
    for (let i = 1; i < r4.length; i++) expect(Math.abs((r4[i] - r4[i - 1]) / period - 1)).toBeLessThan(0.001);
    const h4 = highs(4);
    expect(h4.filter(([, h]) => Math.abs(h / period - 0.5) > 0.005 && Math.abs(h / period - 0.25) > 0.005)).toEqual([]);
    expect(h4.filter(([t]) => t < ready + 900 * MS).every(([, h]) => Math.abs(h / period - 0.5) <= 0.005)).toBe(true);
    expect(h4.some(([, h]) => Math.abs(h / period - 0.25) <= 0.005)).toBe(true);
  }, 60_000);
});

describe('ADC1 on real firmware (BT35)', () => {
  it('adc-read: analogRead follows the pad voltage (11 dB full scale 3.3 V), attenuation and resolution, per channel', () => {
    const { mcu, out, run } = boot('adc-read');
    const pin = (g: number) => mcu.pins.get(`GPIO${g}`)!;
    for (let i = 0; i < 60 && !out[0].includes('\n'); i++) run(10);
    const lastLine = (): Record<string, number[]> => {
      // The last complete line (the next may be half way out of the UART).
      const lines = out[0].slice(0, out[0].lastIndexOf('\n')).split('\n');
      const m = /^a=(\d+) z=(\d+) r=(\d+) c=(\d+),(\d+),(\d+),(\d+),(\d+)\r?$/.exec(lines[lines.length - 1]);
      if (m === null) throw new Error(`no reading in ${JSON.stringify(lines[lines.length - 1])}`);
      const n = m.slice(1).map(Number);
      return { a: [n[0]], z: [n[1]], r: [n[2]], c: n.slice(3) };
    };
    const ideal = (v: number, fs: number, max: number): number => Math.round((v / fs) * max);
    for (const [v, want] of [
      [0, 0],
      [0.825, 1024],
      [1.65, 2048],
      [2.475, 3071],
      [3.3, 4095],
    ] as const) {
      pin(34).setInput(volts(v));
      run(60);
      const line = lastLine();
      expect(Math.abs(line.a[0] - want), `${v} V`).toBeLessThanOrEqual(3);
      expect(Math.abs(line.r[0] - ideal(v, 3.3, 1023)), `${v} V at 10 bits`).toBeLessThanOrEqual(1);
    }
    pin(34).setInput(volts(0.55));
    run(60);
    expect(Math.abs(lastLine().z[0] - 2048)).toBeLessThanOrEqual(3); // 0 dB: full scale 1.1 V
    // Each ADC1 channel reads its own GPIO: CH0 36, CH3 39, CH4 32, CH5 33, CH7 35.
    const set = [
      [36, 0.3],
      [39, 0.6],
      [32, 0.9],
      [33, 1.2],
      [35, 1.5],
    ] as const;
    for (const [g, v] of set) pin(g).setInput(volts(v));
    run(60);
    const c = lastLine().c;
    set.forEach(([, v], i) => expect(Math.abs(c[i] - ideal(v, 3.3, 4095)), `GPIO${set[i][0]}`).toBeLessThanOrEqual(3));
    expect(pin(34).mode()).toBe('analog');
  }, 60_000);
});

describe('SPI masters on real firmware (BT36)', () => {
  it('spi-loopback: every byte reaches the selected device in order, bit order and modes honored, CS high sends nothing, timing bits / f_sck', () => {
    const { mcu, out, run } = boot('spi-loopback');
    const reverse8 = (b: number): number => {
      let r = 0;
      for (let i = 0; i < 8; i++) r |= ((b >>> i) & 1) << (7 - i);
      return r;
    };
    const seen: Record<number, number[]> = { 2: [], 3: [] };
    for (const [host, cs] of [
      [3, 'GPIO5'],
      [2, 'GPIO15'],
    ] as const) {
      const pin = mcu.pins.get(cs)!;
      mcu.spi(host)!.attach({ transfer: (mosi) => (seen[host].push(mosi), ~mosi & 0xff) }, () => pin.outputLevel() === 0 && pin.mode() === 'output');
    }
    const transactions: { start: number; end: number; bits: number; host: number }[] = [];
    mcu.soc.spi3.onTransaction = (start, end, bits) => transactions.push({ start, end, bits, host: 3 });
    mcu.soc.spi2.onTransaction = (start, end, bits) => transactions.push({ start, end, bits, host: 2 });
    for (let i = 0; i < 100 && !out[0].includes('done'); i++) run(10);
    expect(out[0]).toBe(['v1m', 'v8m', 'vlsb', 'vm3'].map((n) => `${n} sum=32640\n`).join('') + `nocs sum=${16 * 255}\nh1m sum=32640\ndone\r\n`);
    const ramp = Array.from({ length: 256 }, (_, i) => i);
    // VSPI: four runs of 0–255 (the LSB-first run arrives bit-reversed on the wire), none while CS was high.
    expect(seen[3]).toEqual([...ramp, ...ramp, ...ramp.map(reverse8), ...ramp]);
    expect(seen[2]).toEqual(ramp);
    expect(mcu.spi(3)!.pins()).toEqual({ sck: 'GPIO18', mosi: 'GPIO23', miso: 'GPIO19' });
    expect(mcu.spi(2)!.pins()).toEqual({ sck: 'GPIO14', mosi: 'GPIO13', miso: 'GPIO12' });
    // One byte per transaction: 8 bits at 1 MHz = 8 µs, at 8 MHz = 1 µs (±5 %).
    const v = transactions.filter((t) => t.host === 3 && t.bits === 8);
    const us = (t: { start: number; end: number }): number => ((t.end - t.start) / REF_HZ) * 1e6;
    expect(Math.abs(us(v[0]) / 8 - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(us(v[256]) / 1 - 1)).toBeLessThanOrEqual(0.05);
  }, 60_000);
});

describe('RMT on real firmware (BT37)', () => {
  /** GPIO g's output edges ([time, level]) after it first becomes a peripheral output. */
  function recordEdges(mcu: Esp32Mcu, g: number): [number, number][] {
    const edges: [number, number][] = [];
    const pin = mcu.pins.get(`GPIO${g}`)!;
    pin.onOutputChange(() => {
      const level = pin.outputLevel();
      if (edges.length === 0 || edges[edges.length - 1][1] !== level) edges.push([mcu.cycles, level]);
    });
    return edges;
  }
  const ns = (cycles: number): number => (cycles / REF_HZ) * 1e9;

  it('neopixel: neopixelWrite(4, …) sends red, green, blue, dim white in GRB order with WS2812 bit timing (±50 ns)', () => {
    const { mcu, out, run } = boot('neopixel');
    const edges = recordEdges(mcu, 4);
    for (let i = 0; i < 300 && !out[0].includes('color 3\n'); i++) run(10);
    run(10);
    expect(out[0]).toBe('color 0\ncolor 1\ncolor 2\ncolor 3\n');
    expect(mcu.pins.get('GPIO4')!.mode()).toBe('peripheral');
    // Frames: runs of pulses separated by more than 50 µs low.
    const frames: { high: number; low: number }[][] = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      if (edges[i][1] !== 1) continue;
      const high = ns(edges[i + 1][0] - edges[i][0]);
      const low = i + 2 < edges.length ? ns(edges[i + 2][0] - edges[i + 1][0]) : Number.POSITIVE_INFINITY;
      if (frames.length === 0 || (i >= 2 && ns(edges[i][0] - edges[i - 1][0]) > 50_000)) frames.push([]);
      frames[frames.length - 1].push({ high, low });
    }
    expect(frames.map((f) => f.length)).toEqual([24, 24, 24, 24]);
    const colors = frames.map((frame) => {
      let grb = 0;
      frame.forEach(({ high, low }, bit) => {
        const one = high > 600;
        expect(Math.abs(high - (one ? 800 : 400))).toBeLessThanOrEqual(50);
        if (bit < 23) expect(Math.abs(low - (one ? 400 : 800))).toBeLessThanOrEqual(50);
        grb = (grb << 1) | (one ? 1 : 0);
      });
      return [(grb >>> 8) & 0xff, (grb >>> 16) & 0xff, grb & 0xff]; // r, g, b
    });
    expect(colors).toEqual([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [32, 32, 32],
    ]);
    expect(mcu.soc.problems.problems.filter((p) => p.code === 'esp32-rmt-unsupported')).toEqual([]);
  }, 60_000);

  it('rmt-long: 150 items through a 64-item block come out whole and in order (TX threshold refill, wrap)', () => {
    const { mcu, out, run } = boot('rmt-long');
    const edges = recordEdges(mcu, 18);
    for (let i = 0; i < 100 && !out[0].includes('second'); i++) run(10);
    expect(out[0]).toBe('first\r\nsecond\r\n');
    const pulses: { high: number; low: number }[] = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      if (edges[i][1] !== 1) continue;
      pulses.push({ high: ns(edges[i + 1][0] - edges[i][0]), low: i + 2 < edges.length ? ns(edges[i + 2][0] - edges[i + 1][0]) : Number.POSITIVE_INFINITY });
    }
    expect(pulses.length).toBe(300);
    pulses.forEach(({ high, low }, i) => {
      const item = i % 150;
      expect(high).toBeCloseTo(i < 150 ? 1000 : 1000 + (item % 10) * 100, 6);
      if (item < 149) expect(low).toBeCloseTo(2000, 6);
    });
    expect(mcu.soc.rmt.items).toBe(300);
  }, 60_000);
});
