import { avrMcuFactory } from '@benchtop/avr';
import { Bench, NS_PER_MS, parseProject, type ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { analogSpecFor } from '../analog-specs.ts';
import { benchEnvParts } from '../catalog.ts';

// Logic analyzer probes (BT23) on real firmware: edge times straight from the bench's rings.

const project = (name: string): ProjectDoc => JSON.parse(readFixtureText(`fixtures/projects/${name}.json`)) as ProjectDoc;

function load(name: string, firmware: string): Bench {
  const parsed = parseProject(project(name));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: avrMcuFactory }, { analogSpecFor });
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  return bench;
}

/** A probe's recording as plain (time µs, level) edges. */
function edges(bench: Bench, id: number): { t: number; level: number }[] {
  const read = bench.readProbe(id, 0);
  if (read === undefined) throw new Error(`no probe ${id}`);
  return Array.from(read.times, (t, i) => ({ t: t / 1000, level: read.levels[i] }));
}

const spread = (values: number[]) => ({ min: Math.min(...values), max: Math.max(...values), n: values.length });

describe('logic analyzer probes', () => {
  it('logic-demo for 1 s: D3 bits 104.17 µs, D9 period 2040.8 µs / high 512 µs, D7 period 2.000 ms', () => {
    const bench = load('logic-demo', 'logic-demo');
    const d3 = bench.addProbe({ part: 'uno', pin: '3' });
    const d9 = bench.addProbe({ part: 'uno', pin: '9' });
    const d7 = bench.addProbe({ part: 'uno', pin: '7' });
    expect([d3, d9, d7]).toEqual([0, 1, 2]);
    bench.runUntil(1000 * NS_PER_MS);

    // D3: every edge inside a byte is one bit apart ('U' alternates); the gaps between bytes are longer.
    const tx = edges(bench, d3).slice(1);
    const bits = tx.slice(1).map((e, i) => e.t - tx[i].t).filter((dt) => dt < 200);
    // D9: rising to rising, and rising to the next falling edge.
    const pwm = edges(bench, d9).slice(1);
    const rises = pwm.filter((e) => e.level === 1).map((e) => e.t);
    const periods9 = rises.slice(1).map((t, i) => t - rises[i]);
    const highs = pwm.flatMap((e, i) => (e.level === 1 && pwm[i + 1]?.level === 0 ? [pwm[i + 1].t - e.t] : []));
    // D7: rising to rising.
    const clock = edges(bench, d7).filter((e, i) => i > 0 && e.level === 1).map((e) => e.t);
    const periods7 = clock.slice(1).map((t, i) => t - clock[i]);
    console.info(
      `logic-demo 1 s: D3 bit µs ${JSON.stringify(spread(bits))}; D9 period µs ${JSON.stringify(spread(periods9))}, high µs ${JSON.stringify(spread(highs))}; D7 period µs ${JSON.stringify(spread(periods7))}`,
    );

    expect(bits.length).toBeGreaterThan(4000); // ~500 bytes × 9 in-byte gaps
    for (const dt of bits) expect(Math.abs(dt - 104.17)).toBeLessThanOrEqual(2);
    expect(periods9.length).toBeGreaterThan(480);
    for (const p of periods9) expect(Math.abs(p - 2040.8)).toBeLessThanOrEqual(2);
    for (const h of highs) expect(Math.abs(h - 512)).toBeLessThanOrEqual(5);
    expect(periods7.length).toBeGreaterThan(490);
    for (const p of periods7) expect(Math.abs(p - 2000)).toBeLessThanOrEqual(10);
  });

  it('a probe records its initial state, then changes only; probing a second pin on one net shares it', () => {
    const bench = load('blink-led', 'blink');
    const id = bench.addProbe({ part: 'uno', pin: '13' });
    expect(bench.addProbe({ part: 'r1', pin: '1' })).toBe(id); // r1:1 sits on D13's net
    expect(bench.addProbe({ part: 'uno', pin: 'nope' })).toBe(-1);
    bench.runUntil(1200 * NS_PER_MS);
    const recorded = edges(bench, id);
    expect(recorded[0]).toEqual({ t: 0, level: 2 }); // floating before setup() runs
    const changes = recorded.slice(1);
    expect(changes.map((e) => e.level)).toEqual([0, 1, 0, 1].slice(4 - changes.length));
    expect(changes.filter((e) => e.level === 1).map((e) => Math.round(e.t / 1000))).toEqual([0, 1000].slice(2 - changes.filter((e) => e.level === 1).length));
    // Reset restarts the recording at t = 0 with the state then.
    bench.reset();
    expect(edges(bench, id)).toEqual([{ t: 0, level: 2 }]);
    bench.removeProbe(id);
    expect(bench.readProbe(id, 0)).toBeUndefined();
  });

  it('a probe on D1 is flagged peripheral once Serial.begin enables the USART transmitter', () => {
    const bench = load('blink-led', 'blink');
    const id = bench.addProbe({ part: 'uno', pin: '1' });
    expect(bench.probePeripheral(id)).toBe(false);
    bench.runUntil(10 * NS_PER_MS);
    expect(bench.probePeripheral(id)).toBe(true);
    // The USART doesn't drive the pin in the simulation: the net just idles high.
    expect(edges(bench, id).map((e) => e.level).at(-1)).toBe(1);
  });

  it("Blink's simulated MHz with 4 probes stays within 3 % of no probes", () => {
    const mhz = (probes: number): number => {
      const bench = load('blink-led', 'blink');
      for (const pin of ['13', '12', '2', 'A0'].slice(0, probes)) bench.addProbe({ part: 'uno', pin });
      const start = performance.now();
      bench.runUntil(200 * NS_PER_MS);
      return 3.2e6 / ((performance.now() - start) * 1000);
    };
    mhz(4); // warm up
    // Best of many short alternating runs: machine load only ever slows a run down, and the
    // full verify runs test files in parallel.
    let none = 0;
    let four = 0;
    for (let k = 0; k < 8; k++) {
      none = Math.max(none, mhz(0));
      four = Math.max(four, mhz(4));
    }
    console.info(`blink: ${none.toFixed(2)} simulated MHz with no probes, ${four.toFixed(2)} with 4 (${(((four - none) / none) * 100).toFixed(1)} %)`);
    expect(four).toBeGreaterThanOrEqual(none * 0.97);
  }, 30_000); // 3.4 s of simulated time: ~3.5 s of wall time alone, more under load
});
