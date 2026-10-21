import { Bench, type BenchEnv, NS_PER_US, type PartDefinition, type ProjectDoc, Strength } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { benchEnvParts } from '../catalog.ts';
import { dhtFrame } from './dht22.ts';
import { advanceSecond, daysInMonth, startRegisters } from './ds1307.ts';
import { ECHO_NS_PER_CM } from './hc-sr04.ts';

// Sensor timing without firmware: test parts drive the lines, the net is sampled every 1 µs.

/** Test part: drives its pin strong 0 while pressed, high while 'key high' is down, else hiz. */
const driver: PartDefinition = {
  type: 'test-driver',
  title: 'driver',
  category: 'sensors',
  size: { w: 5, h: 5 },
  pins: [{ name: 'P', x: 0, y: 0, role: 'digital' }],
  defaults: {},
  createModel(ctx) {
    const p = ctx.pin('P');
    return {
      input(event) {
        if (event.kind === 'press') p.drive(0, Strength.strong);
        else if (event.kind === 'release') p.release();
        else if (event.kind === 'key') {
          if (event.down) p.drive(1, Strength.strong);
          else p.drive(0, Strength.strong);
        }
      },
    };
  },
};

/** Test part: a pull-up (weak 1) on its pin. */
const pullup: PartDefinition = {
  type: 'test-pullup',
  title: 'pull-up',
  category: 'sensors',
  size: { w: 5, h: 5 },
  pins: [{ name: 'P', x: 0, y: 0, role: 'digital' }],
  defaults: {},
  createModel(ctx) {
    ctx.pin('P').drive(1, Strength.weak);
    return {};
  },
};

const env: BenchEnv = {
  part: (type) => (type === 'test-driver' ? driver : type === 'test-pullup' ? pullup : benchEnvParts(type)),
  createMcu: () => undefined,
};

function bench(sensor: { type: string; props?: Record<string, number> }, pin: string, withPullup: boolean) {
  const doc: ProjectDoc = {
    format: 1,
    name: 'sensor',
    parts: [
      { id: 's', type: sensor.type, x: 0, y: 0, rotation: 0, props: sensor.props ?? {} },
      { id: 'drv', type: 'test-driver', x: 100, y: 0, rotation: 0, props: {} },
      ...(withPullup ? [{ id: 'pu', type: 'test-pullup', x: 120, y: 0, rotation: 0 as const, props: {} }] : []),
    ],
    wires: [
      { id: 'w1', from: { part: 's', pin }, to: { part: 'drv', pin: 'P' }, waypoints: [], color: 'green' },
      ...(withPullup ? [{ id: 'w2', from: { part: 's', pin }, to: { part: 'pu', pin: 'P' }, waypoints: [], color: 'red' }] : []),
    ],
    firmware: {},
  };
  return new Bench(doc, env);
}

/** Runs `us` microseconds in 1 µs steps, returning [time µs, level] at each change of the net. */
function edges(b: Bench, part: string, pin: string, us: number): [number, number | null][] {
  const out: [number, number | null][] = [];
  let last = b.pinState(part, pin)?.level ?? null;
  const end = b.now() + us * NS_PER_US;
  while (b.now() < end) {
    b.runUntil(b.now() + NS_PER_US);
    const level = b.pinState(part, pin)?.level ?? null;
    if (level !== last) out.push([Math.round(b.now() / NS_PER_US), level]);
    last = level;
  }
  return out;
}

describe('DHT22', () => {
  it('encodes humidity, temperature (sign bit) and the checksum', () => {
    expect(dhtFrame(23.4, 45.6)).toEqual([0x01, 0xc8, 0x00, 0xea, (0x01 + 0xc8 + 0xea) & 0xff]);
    const negative = dhtFrame(-12.3, 80);
    expect(negative.slice(0, 4)).toEqual([0x03, 0x20, 0x80, 0x7b]);
    expect(negative[4]).toBe((0x03 + 0x20 + 0x80 + 0x7b) & 0xff);
    expect(dhtFrame(200, -5)).toEqual(dhtFrame(80, 0));
  });

  it('ignores a 0.5 ms low', () => {
    const b = bench({ type: 'dht22' }, 'SDA', true);
    b.runUntil(100 * NS_PER_US);
    b.input('drv', { kind: 'press' });
    b.runUntil(b.now() + 500 * NS_PER_US);
    b.input('drv', { kind: 'release' });
    expect(edges(b, 's', 'SDA', 6000)).toEqual([]);
  });

  it('answers a 1.1 ms start: 30 µs, low 80, high 80, 40 bits of 50 + 26/70 µs, end low 50', () => {
    const b = bench({ type: 'dht22', props: { temperature: 24, humidity: 40 } }, 'SDA', true);
    b.input('s', { kind: 'key', key: 'set:temperature=-12.3', down: true });
    b.input('s', { kind: 'key', key: 'set:humidity=80', down: true });
    b.runUntil(100 * NS_PER_US);
    b.input('drv', { kind: 'press' });
    b.runUntil(b.now() + 1100 * NS_PER_US);
    b.input('drv', { kind: 'release' });
    const t0 = Math.round(b.now() / NS_PER_US);
    const seen = edges(b, 's', 'SDA', 6000).map(([t, level]) => [t - t0, level] as const);
    expect(seen.slice(0, 3)).toEqual([
      [30, 0],
      [110, 1],
      [190, 0],
    ]);
    // 40 bits: each low 50 µs, then high 26 µs (0) or 70 µs (1).
    const bits: number[] = [];
    for (let i = 0; i < 40; i++) {
      const fall = seen[2 + 2 * i];
      const rise = seen[3 + 2 * i];
      const nextFall = seen[4 + 2 * i];
      expect(rise[0] - fall[0]).toBe(50);
      const high = nextFall[0] - rise[0];
      expect([26, 70]).toContain(high);
      bits.push(high === 70 ? 1 : 0);
    }
    const bytes = Array.from({ length: 5 }, (_, k) => bits.slice(8 * k, 8 * k + 8).reduce((n, bit) => (n << 1) | bit, 0));
    expect(bytes).toEqual(dhtFrame(-12.3, 80));
    const last = seen.at(-1)!;
    expect(last[1]).toBe(1);
    expect(last[0] - seen.at(-2)![0]).toBe(50);
    expect(seen).toHaveLength(2 + 80 + 2); // preamble low/high, 40 × (fall, rise), end low and release
  });
});

describe('HC-SR04', () => {
  function sonar(distance: number) {
    const b = bench({ type: 'hc-sr04', props: { distance } }, 'TRIG', false);
    b.runUntil(100 * NS_PER_US);
    return b;
  }
  const pulse = (b: Bench, us: number): void => {
    b.input('drv', { kind: 'key', key: 'high', down: true });
    b.runUntil(b.now() + us * NS_PER_US);
    b.input('drv', { kind: 'key', key: 'high', down: false });
  };

  it('ignores a 5 µs trigger', () => {
    const b = sonar(100);
    pulse(b, 5);
    expect(edges(b, 's', 'ECHO', 10_000)).toEqual([]);
  });

  it('echoes 200 µs after a 10 µs trigger, for 58.31 µs per cm', () => {
    const b = sonar(100);
    pulse(b, 10);
    const t0 = Math.round(b.now() / NS_PER_US);
    const seen = edges(b, 's', 'ECHO', 8000).map(([t, level]) => [t - t0, level]);
    expect(seen[0]).toEqual([200, 1]);
    expect(Math.abs((seen[1][0] as number) - 200 - 100 * (ECHO_NS_PER_CM / 1000))).toBeLessThanOrEqual(1);
    expect(seen[1][1]).toBe(0);
  });

  it('holds the echo 38 ms beyond 400 cm, and ignores triggers during an echo', () => {
    const b = sonar(500);
    pulse(b, 12);
    b.runUntil(b.now() + 1000 * NS_PER_US);
    pulse(b, 12); // during the echo: ignored
    const seen = edges(b, 's', 'ECHO', 45_000);
    expect(seen).toHaveLength(1); // only the fall
    expect(seen[0][1]).toBe(0);
  });
});

describe('DS1307 calendar', () => {
  const regs = (start: string): Uint8Array => startRegisters(start, false);
  const text = (r: Uint8Array): string => [6, 5, 4, 2, 1, 0].map((i) => (r[i] & (i === 0 ? 0x7f : 0xff)).toString(16).padStart(2, '0')).join(' ');

  it('knows month lengths and leap years', () => {
    expect([1, 2, 3, 4, 6, 9, 11, 12].map((m) => daysInMonth(m, 27))).toEqual([31, 28, 31, 30, 30, 30, 30, 31]);
    expect(daysInMonth(2, 28)).toBe(29);
    expect(daysInMonth(2, 0)).toBe(29);
  });

  it('carries 2028-02-28 23:59:59 into the 29th and 2027-02-28 into March', () => {
    const leap = regs('2028-02-28T23:59:59');
    advanceSecond(leap);
    expect(text(leap)).toBe('28 02 29 00 00 00');
    const plain = regs('2027-02-28T23:59:59');
    advanceSecond(plain);
    expect(text(plain)).toBe('27 03 01 00 00 00');
    const year = regs('2026-12-31T23:59:59');
    advanceSecond(year);
    expect(text(year)).toBe('27 01 01 00 00 00');
  });

  it('runs a 12 h clock: 11:59:59 PM → 12:00:00 AM of the next day, AM → PM at noon', () => {
    const r = regs('2026-10-19T00:00:00');
    r[2] = 0x40 | 0x20 | 0x11; // 11 PM
    r[1] = 0x59;
    r[0] = 0x59;
    advanceSecond(r);
    expect(r[2]).toBe(0x40 | 0x12); // 12 AM
    expect(r[4]).toBe(0x20);
    r[2] = 0x40 | 0x11; // 11 AM
    r[1] = 0x59;
    r[0] = 0x59;
    advanceSecond(r);
    expect(r[2]).toBe(0x40 | 0x20 | 0x12); // 12 PM, same day
    expect(r[4]).toBe(0x20);
    r[1] = 0x59;
    r[0] = 0x59;
    advanceSecond(r);
    expect(r[2]).toBe(0x40 | 0x20 | 0x01); // 1 PM
  });
});
