import { describe, expect, it } from 'vitest';
import { Strength } from '../contracts/signal.ts';
import { type ResolverLink, SignalResolver } from './resolver.ts';

const resistive = (a: number, b: number): ResolverLink => ({ a, b, kind: 'resistive', closed: true });
const openSwitch = (a: number, b: number): ResolverLink => ({ a, b, kind: 'switch', closed: false });
const closedSwitch = (a: number, b: number): ResolverLink => ({ a, b, kind: 'switch', closed: true });

/** A copy of a net's state, so assertions don't see later in-place mutation. */
function snap(r: SignalResolver, net: number) {
  const { level, strength, conflict, volts } = r.state(net);
  return { level, strength, conflict, volts };
}

describe('SignalResolver', () => {
  it('pull-up button: weak 1 reads 0 through a closed switch to supply 0, weak 1 when open', () => {
    const PIN = 0;
    const GND = 1;
    const r = new SignalResolver(2, [openSwitch(PIN, GND)]);
    r.setDriver(r.allocDriver(PIN, 5), 1, Strength.weak);
    r.setDriver(r.allocDriver(GND, 5), 0, Strength.supply);
    expect(snap(r, PIN)).toEqual({ level: 1, strength: Strength.weak, conflict: false, volts: 5 });
    r.setLinkClosed(0, true);
    expect(snap(r, PIN)).toEqual({ level: 0, strength: Strength.supply, conflict: false, volts: 0 });
    expect(snap(r, GND)).toEqual({ level: 0, strength: Strength.supply, conflict: false, volts: 0 });
    r.setLinkClosed(0, false);
    expect(snap(r, PIN)).toEqual({ level: 1, strength: Strength.weak, conflict: false, volts: 5 });
  });

  it('an MCU output through a resistor reaches the LED anode as weak 1 with the source volts', () => {
    const r = new SignalResolver(2, [resistive(0, 1)]);
    r.setDriver(r.allocDriver(0, 5), 1, Strength.strong);
    expect(snap(r, 1)).toEqual({ level: 1, strength: Strength.weak, conflict: false, volts: 5 });
    expect(snap(r, 0)).toEqual({ level: 1, strength: Strength.strong, conflict: false, volts: 5 });
  });

  it('flags strong 1 vs supply 0 as a conflict won by supply, strong vs strong as level null', () => {
    const r = new SignalResolver(2, []);
    r.setDriver(r.allocDriver(0, 5), 1, Strength.strong);
    r.setDriver(r.allocDriver(0, 5), 0, Strength.supply);
    expect(snap(r, 0)).toEqual({ level: 0, strength: Strength.supply, conflict: true, volts: 0 });
    r.setDriver(r.allocDriver(1, 5), 1, Strength.strong);
    r.setDriver(r.allocDriver(1, 5), 0, Strength.strong);
    expect(snap(r, 1)).toMatchObject({ level: null, strength: Strength.strong, conflict: true });
  });

  it('reports a short across a closed switch on both nets', () => {
    const r = new SignalResolver(2, [closedSwitch(0, 1)]);
    r.setDriver(r.allocDriver(0, 5), 1, Strength.strong);
    r.setDriver(r.allocDriver(1, 5), 0, Strength.strong);
    expect(snap(r, 0)).toMatchObject({ level: null, conflict: true });
    expect(snap(r, 1)).toMatchObject({ level: null, conflict: true });
  });

  it('leaves a net with only hiz drivers floating', () => {
    const r = new SignalResolver(1, []);
    const a = r.allocDriver(0, 5);
    r.allocDriver(0, 3.3);
    r.setDriver(a, 1, Strength.strong);
    r.releaseDriver(a);
    expect(snap(r, 0)).toEqual({ level: null, strength: Strength.hiz, conflict: false, volts: 0 });
  });

  it('two resistors from strong 1: weak 1 at the far end, no feedback when the far end is driven strong 0', () => {
    const NEAR = 0;
    const MID = 1;
    const FAR = 2;
    const r = new SignalResolver(3, [resistive(NEAR, MID), resistive(MID, FAR)]);
    r.setDriver(r.allocDriver(NEAR, 5), 1, Strength.strong);
    expect(snap(r, FAR)).toEqual({ level: 1, strength: Strength.weak, conflict: false, volts: 5 });
    r.setDriver(r.allocDriver(FAR, 5), 0, Strength.strong);
    expect(snap(r, NEAR)).toEqual({ level: 1, strength: Strength.strong, conflict: false, volts: 5 });
    expect(snap(r, FAR)).toEqual({ level: 0, strength: Strength.strong, conflict: false, volts: 0 });
    // The middle is a divider: weak 1 one way, weak 0 the other — undetermined, not a short.
    expect(snap(r, MID)).toEqual({ level: null, strength: Strength.weak, conflict: false, volts: 2.5 });
  });

  it('a strong driver overrides a pull-up, and what lies behind it sees the strong level', () => {
    const r = new SignalResolver(3, [resistive(0, 1), resistive(1, 2)]);
    r.setDriver(r.allocDriver(0, 5), 1, Strength.supply);
    r.setDriver(r.allocDriver(1, 5), 0, Strength.strong);
    expect(snap(r, 1)).toMatchObject({ level: 0, strength: Strength.strong, conflict: false });
    expect(snap(r, 2)).toMatchObject({ level: 0, strength: Strength.weak });
  });

  it('cuts off a link loop that oscillates through a listener, and reports it', () => {
    const A = 0;
    const B = 1;
    const r = new SignalResolver(2, [resistive(A, B)]);
    const driver = r.allocDriver(A, 5);
    let calls = 0;
    // An inverter with zero delay from B back onto A: it can never settle.
    r.onChange = (net) => {
      calls++;
      if (net === B) r.setDriver(driver, r.state(B).level === 1 ? 0 : 1, Strength.strong);
    };
    r.setDriver(driver, 1, Strength.strong);
    expect([...r.oscillations()].sort()).toEqual([A, B]);
    // Bounded: 4 × (nets + links + 1) = 16 recomputations, two notifications each at most.
    expect(calls).toBeLessThanOrEqual(2 * 16);
    r.clearOscillations();
    expect(r.oscillations()).toEqual([]);
  });

  it('fires onChange exactly once per actual change, after the whole component is updated', () => {
    const r = new SignalResolver(2, [resistive(0, 1)]);
    const d = r.allocDriver(0, 5);
    const seen: string[] = [];
    r.onChange = (net) => seen.push(`${net}:${r.state(0).level}/${r.state(1).level}`);
    r.setDriver(d, 1, Strength.strong);
    expect(seen).toEqual(['0:1/1', '1:1/1']);
    seen.length = 0;
    r.setDriver(d, 1, Strength.strong); // same value: nothing to do
    r.setDriver(d, 1, Strength.supply); // net 0 changes strength; net 1 stays weak 1
    expect(seen).toEqual(['0:1/1']);
    seen.length = 0;
    r.setDriverVolts(d, 3.3, Strength.supply); // same level, new volts: both nets change
    expect(seen).toEqual(['0:1/1', '1:1/1']);
    expect(r.state(1).volts).toBe(3.3);
    seen.length = 0;
    r.setDriverVolts(d, 2.4, Strength.supply); // below highVolts / 2 = 2.5 V → level 0
    expect(r.state(0).level).toBe(0);
    expect(r.state(1)).toMatchObject({ level: 0, volts: 2.4 });
  });

  it('applies a drive made from inside a listener after the current notifications', () => {
    // Net 0 → listener mirrors it onto net 1 (like a part copying DIN to DOUT).
    const r = new SignalResolver(2, []);
    const input = r.allocDriver(0, 5);
    const output = r.allocDriver(1, 5);
    const order: string[] = [];
    r.onChange = (net) => {
      order.push(`net ${net} = ${r.state(net).level}`);
      if (net === 0) {
        r.setDriver(output, r.state(0).level === 1 ? 1 : 0, Strength.strong);
        order.push(`net 1 still ${r.state(1).level}`);
      }
    };
    r.setDriver(input, 1, Strength.strong);
    expect(order).toEqual(['net 0 = 1', 'net 1 still null', 'net 1 = 1']);
    expect(r.oscillations()).toEqual([]);
  });

  it('never latches a level around a cycle of links once its source is gone', () => {
    // Two resistors in parallel between nets 0 and 1.
    const parallel = new SignalResolver(2, [resistive(0, 1), resistive(0, 1)]);
    const d = parallel.allocDriver(0, 5);
    parallel.setDriver(d, 1, Strength.strong);
    expect(parallel.state(1).level).toBe(1);
    parallel.releaseDriver(d);
    expect(snap(parallel, 0)).toMatchObject({ level: null, strength: Strength.hiz });
    expect(snap(parallel, 1)).toMatchObject({ level: null, strength: Strength.hiz });

    // A keypad rectangle: rows 0, 1 and columns 2, 3 with all four keys pressed.
    const keypad = new SignalResolver(4, [closedSwitch(0, 2), closedSwitch(0, 3), closedSwitch(1, 2), closedSwitch(1, 3)]);
    const row = keypad.allocDriver(0, 5);
    const pullups = [2, 3].map((net) => keypad.allocDriver(net, 5));
    for (const p of pullups) keypad.setDriver(p, 1, Strength.weak);
    keypad.setDriver(row, 0, Strength.strong);
    expect([1, 2, 3].map((net) => keypad.state(net).level)).toEqual([0, 0, 0]);
    keypad.releaseDriver(row); // the scan moves on: the row goes back to input
    expect([0, 1, 2, 3].map((net) => keypad.state(net).level)).toEqual([1, 1, 1, 1]);
    expect(keypad.state(1).strength).toBe(Strength.weak);
  });

  it('validates ids and link endpoints', () => {
    expect(() => new SignalResolver(2, [resistive(0, 2)])).toThrow(RangeError);
    const r = new SignalResolver(1, []);
    expect(() => r.allocDriver(1, 5)).toThrow(RangeError);
    expect(() => r.setDriver(0, 1, Strength.strong)).toThrow(RangeError);
    expect(() => r.setLinkClosed(0, true)).toThrow(RangeError);
  });

  it('toggles a driver 1,000,000 times through a resistor with 3 listeners in under 2 s', () => {
    const r = new SignalResolver(2, [resistive(0, 1)]);
    const d = r.allocDriver(0, 5);
    let a = 0;
    let b = 0;
    let c = 0;
    const listeners = [() => a++, () => b++, () => c++];
    r.onChange = (net) => {
      if (net === 0) for (let i = 0; i < 3; i++) listeners[i]();
    };
    const toggles = 1_000_000;
    const start = performance.now();
    for (let i = 0; i < toggles; i++) r.setDriver(d, (i & 1) === 0 ? 1 : 0, Strength.strong);
    const ms = performance.now() - start;
    console.info(
      `resolver: ${toggles} toggles in ${ms.toFixed(0)} ms = ${Math.round((toggles / ms) * 1000).toLocaleString('en-US')} events/s`,
    );
    expect(a + b + c).toBe(3 * toggles);
    expect(r.state(1).level).toBe(0);
    expect(ms).toBeLessThan(2000);
  });
});
