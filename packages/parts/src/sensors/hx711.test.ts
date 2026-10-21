import { type Level, type NetState, type PartContext, Strength } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { HX711_PERIOD_NS, hx711 } from './hx711.ts';

// BT52: the HX711's protocol on a stub context with a manual clock — the test drives PD_SCK and
// reads DOUT; scheduled conversions run as time advances.

function harness(props: Record<string, number | string> = {}) {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  let dout: Level | null = null;
  let sck: Level = 0;
  let sckListener: ((s: NetState) => void) | null = null;
  const state = (level: Level): NetState => ({ level, strength: Strength.strong, conflict: false, volts: level === 1 ? 5 : 0 });
  const ctx = {
    pin: (name: string) => ({
      read: () => state(name === 'SCK' ? sck : (dout ?? 1)),
      onChange: (fn: (s: NetState) => void) => {
        if (name === 'SCK') sckListener = fn;
      },
      drive: (level: Level) => {
        if (name === 'DT') dout = level;
      },
      release: () => {},
    }),
    now: () => now,
    schedule: (delay: number, fn: () => void) => {
      timers.push({ at: now + delay, fn });
      return timers.length;
    },
    invalidate: () => {},
  } as unknown as PartContext;
  const model = hx711.createModel?.(ctx, { ...hx711.defaults, ...props } as never);
  const advance = (ns: number): void => {
    const end = now + ns;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (next === undefined || next.at > end) break;
      timers.shift();
      now = next.at;
      next.fn();
    }
    now = end;
  };
  const setSck = (level: Level): void => {
    sck = level;
    sckListener?.(state(level));
  };
  /** One word: `pulses` PD_SCK pulses (1 µs high, 1 µs low); the first 24 bits as a signed number. */
  const read = (pulses = 25): number => {
    let value = 0;
    for (let i = 0; i < pulses; i++) {
      setSck(1);
      advance(1000);
      if (i < 24) value = (value << 1) | (dout === 1 ? 1 : 0);
      setSck(0);
      advance(1000);
    }
    return value & 0x800000 ? value - 0x1000000 : value;
  };
  return { model, advance, read, setSck, dout: () => dout };
}

describe('HX711 (BT52)', () => {
  it('DOUT goes low 10 times a second; 24 bits MSB first, then high on the 25th pulse', () => {
    const t = harness({ weight: 10, countsPerGram: 100, offset: -5000 });
    expect(t.dout()).toBe(1);
    t.advance(HX711_PERIOD_NS - 1000);
    expect(t.dout()).toBe(1);
    t.advance(1000);
    expect(t.dout()).toBe(0);
    expect(t.read()).toBe(-4000); // −5000 + 10 g × 100
    expect(t.dout()).toBe(1);
    t.advance(HX711_PERIOD_NS);
    expect(t.dout()).toBe(0);
  });

  it('26 pulses select channel B (nothing connected: 0), 27 channel A at gain 64 (half)', () => {
    const t = harness({ weight: 100, countsPerGram: 100 });
    t.advance(HX711_PERIOD_NS);
    expect(t.read(26)).toBe(10_000);
    t.advance(HX711_PERIOD_NS);
    expect(t.read(27)).toBe(0); // the conversion after 26 pulses: channel B
    t.advance(HX711_PERIOD_NS);
    expect(t.read(25)).toBe(5_000); // after 27: A × 64
    t.advance(HX711_PERIOD_NS);
    expect(t.read(25)).toBe(10_000); // after 25: A × 128 again
  });

  it('saturates at the 24-bit limits, and follows weight input', () => {
    const t = harness({ weight: 0, countsPerGram: 1000 });
    t.model?.input?.({ kind: 'value', value: 100_000 });
    t.advance(HX711_PERIOD_NS);
    expect(t.read()).toBe(0x7fffff);
    t.model?.input?.({ kind: 'value', value: -100_000 });
    t.advance(HX711_PERIOD_NS);
    expect(t.read()).toBe(-0x800000);
  });

  it('PD_SCK held high over 60 µs powers down; low again restarts at A × 128 after 100 ms', () => {
    const t = harness({ weight: 1, countsPerGram: 100 });
    t.advance(HX711_PERIOD_NS);
    t.read(27); // ask for gain 64 next…
    t.setSck(1);
    t.advance(61_000); // …then power down
    t.advance(3 * HX711_PERIOD_NS);
    expect(t.dout()).toBe(1); // no conversions while down
    t.setSck(0);
    t.advance(HX711_PERIOD_NS - 1000);
    expect(t.dout()).toBe(1);
    t.advance(1000);
    expect(t.read()).toBe(100); // gain back to 128
  });
});
