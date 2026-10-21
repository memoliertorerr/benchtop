import { serialize } from 'node:v8';
import { LineTable, NS_PER_MS, type ProjectDoc, SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { type FromSim, PROTOCOL_VERSION } from './protocol.ts';
import { SimSession } from './session.ts';

type Frame = Extract<FromSim, { type: 'frame' }>;

/** A session on a manual wall clock: `advance` moves it in 4 ms steps, running queued ticks. */
function harness() {
  let wall = 0;
  let pending: (() => void) | null = null;
  const messages: FromSim[] = [];
  const session = new SimSession({
    // A copy, as postMessage makes: models may reuse their visual objects between frames.
    post: (message) => messages.push(structuredClone(message)),
    now: () => wall,
    schedule: (fn) => {
      pending = fn;
    },
  });
  const advance = (ms: number) => {
    const end = wall + ms;
    while (wall < end) {
      wall = Math.min(end, wall + 4);
      const fn = pending;
      pending = null;
      fn?.();
    }
  };
  const frames = () => messages.filter((m): m is Frame => m.type === 'frame');
  const serialText = (board: string) =>
    messages
      .filter((m) => m.type === 'serial' && m.board === board)
      .map((m) => (m.type === 'serial' ? String.fromCharCode(...m.bytes) : ''))
      .join('');
  return { session, messages, advance, frames, serialText };
}

const project = (name: string): ProjectDoc => JSON.parse(readFixtureText(`fixtures/projects/${name}.json`));
const hex = (name: string) => ({ format: 'hex' as const, text: readFixtureText(`fixtures/firmware/uno/${name}.hex`) });

describe('SimSession', () => {
  it('runs blink in real time: the LED flips at 500 ms ± 1 frame and serial says hello', () => {
    const h = harness();
    h.session.handle({ type: 'hello', protocol: PROTOCOL_VERSION });
    h.session.handle({ type: 'load', doc: project('blink-led'), firmware: { uno: hex('blink') } });
    expect(h.messages.slice(0, 2)).toEqual([
      { type: 'ready', protocol: PROTOCOL_VERSION },
      { type: 'loaded', problems: [] },
    ]);
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(1200);

    // The frame posted on load carries every part that has visual state (a fresh bench), the LED dark.
    expect(h.frames()[0].parts.map(([id]) => id).sort()).toEqual(['led1', 'uno']);
    const led = h.frames().flatMap((f) => f.parts.filter(([id]) => id === 'led1').map(([, v]) => ({ t: f.t / NS_PER_MS, b: v.brightness })));
    // The session runs the analog layer: lit means 12.5 mA through 220 Ω, shown as √(12.5/15).
    expect(led.map((l) => ((l.b as number) > 0.5 ? 1 : 0))).toEqual([0, 1, 0, 1]);
    expect(led[1].b).toBeCloseTo(0.915, 2);
    expect(led[1].t).toBeLessThanOrEqual(16);
    expect(Math.abs(led[2].t - 500)).toBeLessThanOrEqual(16);
    expect(Math.abs(led[3].t - 1000)).toBeLessThanOrEqual(16);

    expect(h.serialText('uno')).toBe('hello\r\n');
    // The board's TX LED flashed for the bytes the session forwarded.
    expect(h.frames().some((f) => f.parts.some(([id, v]) => id === 'uno' && v.ledTx === true))).toBe(true);

    const last = h.frames().at(-1)!;
    expect(last.running).toBe(true);
    expect(last.t / NS_PER_MS).toBeCloseTo(1200, -1);
    expect(last.stats.ratio).toBeCloseTo(1, 1);
    expect(last.stats.mhz.uno).toBeCloseTo(16, 0);
  });

  it('stops simulated time on pause and advances exactly on step', () => {
    const h = harness();
    h.session.handle({ type: 'load', doc: project('blink-led'), firmware: { uno: hex('blink') } });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(100);
    h.session.handle({ type: 'pause' });
    const paused = h.frames().at(-1)!;
    expect(paused.running).toBe(false);
    const count = h.frames().length;
    h.advance(200);
    expect(h.frames()).toHaveLength(count);
    h.session.handle({ type: 'step', ns: 10 * NS_PER_MS });
    expect(h.frames().at(-1)!.t).toBe(paused.t + 10 * NS_PER_MS);
    h.session.handle({ type: 'reset' });
    expect(h.frames().at(-1)!.t).toBe(0);
  });

  it('delivers input to part models: pressing the button lights D13', () => {
    const h = harness();
    h.session.handle({ type: 'load', doc: project('button-pullup'), firmware: { uno: hex('button-pullup') } });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(100);
    h.session.handle({ type: 'input', part: 'btn1', event: { kind: 'press' } });
    h.advance(40);
    const seen = Object.fromEntries(h.frames().flatMap((f) => f.parts));
    expect(seen.btn1).toEqual({ pressed: true });
    expect(seen.led1).toMatchObject({ brightness: expect.closeTo(0.915, 2) });
  });

  it('answers a protocol mismatch, a bad project and a bench error with `error`, never a throw', () => {
    const h = harness();
    h.session.handle({ type: 'hello', protocol: 1 });
    expect(h.messages.at(-1)).toEqual({ type: 'error', message: `protocol mismatch: ui 1, worker ${PROTOCOL_VERSION}` });
    h.session.handle({ type: 'run', speed: 1 });
    expect(h.messages.at(-1)).toEqual({ type: 'error', message: 'nothing loaded' });
    h.session.handle({ type: 'load', doc: { format: 2 } as unknown as ProjectDoc, firmware: {} });
    expect(h.messages.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('invalid project') });
    h.session.handle({ type: 'load', doc: project('blink-led'), firmware: { uno: { format: 'hex', text: ':0000' } } });
    expect(h.messages.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('line 1') });
    h.session.handle({ type: 'load', doc: project('blink-led'), firmware: {} });
    h.session.handle({ type: 'input', part: 'ghost', event: { kind: 'press' } });
    expect(h.messages.at(-1)).toEqual({ type: 'error', message: 'no part "ghost" on the bench' });
  });

  it('swaps one board firmware on a running bench without restarting time', () => {
    const h = harness();
    h.session.handle({ type: 'load', doc: project('blink-led'), firmware: {} });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(300);
    expect(h.serialText('uno')).toBe('');
    const before = h.frames().at(-1)!.t;
    const framesBefore = h.frames().length;
    h.session.handle({ type: 'setFirmware', board: 'uno', image: hex('blink') });
    const swapped = h.frames().at(-1)!;
    // A frame right away, at the bench's current time (not back to 0).
    expect(swapped.t).toBeGreaterThanOrEqual(before);
    expect(swapped.t / NS_PER_MS).toBeCloseTo(300, -1);
    expect(swapped.running).toBe(true);
    h.advance(1100);
    expect(h.serialText('uno')).toBe('hello\r\n');
    const led = h
      .frames()
      .slice(framesBefore)
      .flatMap((f) => f.parts.filter(([id]) => id === 'led1').map(([, v]) => ({ t: f.t / NS_PER_MS, b: v.brightness })));
    // The new program starts at the swap (~300 ms): on at once, off ~500 ms later, on again.
    expect(led.map((l) => ((l.b as number) > 0.5 ? 1 : 0))).toEqual([1, 0, 1]);
    expect(Math.abs(led[0].t - 300)).toBeLessThanOrEqual(16);
    expect(Math.abs(led[1].t - 800)).toBeLessThanOrEqual(16);
    h.session.handle({ type: 'setFirmware', board: 'ghost', image: hex('blink') });
    expect(h.messages.at(-1)).toMatchObject({ type: 'error' });
  });

  it('reports problems when the set changes', () => {
    const h = harness();
    h.session.handle({ type: 'load', doc: project('short-d13'), firmware: { uno: hex('blink') } });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(300);
    const problems = h.messages.filter((m) => m.type === 'problems');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ list: [{ code: 'drive-fight', parts: ['uno'] }] });
    h.advance(400); // D13 goes low at 500 ms: the short clears
    expect(h.messages.filter((m) => m.type === 'problems').at(-1)).toEqual({ type: 'problems', list: [], counts: { error: 0, warning: 0, info: 0 } });
  });

  it('sends one problems message over a steady run, and one more when an edit removes the fault', () => {
    const h = harness();
    const doc = project('problems-floating');
    h.session.handle({ type: 'load', doc, firmware: { uno: hex('checker-demo') } });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(1000);
    const problems = () => h.messages.filter((m) => m.type === 'problems');
    expect(problems()).toHaveLength(1);
    expect(problems()[0]).toMatchObject({ list: [{ code: 'floating-input', parts: ['btn1', 'uno'] }], counts: { error: 0, warning: 1, info: 0 } });
    // The edit: the button and its wires go.
    const fixed: ProjectDoc = { ...doc, parts: doc.parts.filter((p) => p.id !== 'btn1'), wires: [] };
    h.session.handle({ type: 'load', doc: fixed, firmware: { uno: hex('checker-demo') } });
    expect(problems()).toHaveLength(2);
    expect(problems()[1]).toMatchObject({ list: [], counts: { error: 0, warning: 0, info: 0 } });
  });

  it('measures the frame payload of a 100-LED circuit', () => {
    const doc: ProjectDoc = {
      format: 1,
      name: '100 LEDs',
      parts: [
        { id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} },
        // 12 mm apart: closer, neighboring legs would touch (contacts) and short 5V to GND.
        ...Array.from({ length: 100 }, (_, i) => ({ id: `led${i}`, type: 'led', x: i * 12, y: 60, rotation: 0 as const, props: { color: 'red' } })),
      ],
      wires: Array.from({ length: 100 }, (_, i) => [
        { id: `a${i}`, from: { part: `led${i}`, pin: 'A' }, to: { part: 'uno', pin: '5V' }, waypoints: [], color: 'red' },
        { id: `c${i}`, from: { part: `led${i}`, pin: 'C' }, to: { part: 'uno', pin: 'GND.1' }, waypoints: [], color: 'black' },
      ]).flat(),
      firmware: {},
    };
    const h = harness();
    h.session.handle({ type: 'load', doc, firmware: {} });
    const frame = h.frames().at(-1)!;
    expect(frame.parts.filter(([id, v]) => id.startsWith('led') && v.brightness === 1)).toHaveLength(100);
    const bytes = serialize(frame).length;
    console.info(`frame payload, 100 LEDs changing (+ the Uno): ${bytes} bytes (structured clone, node:v8)`);
    expect(bytes).toBeLessThan(16_384);
  });

  it('streams probe edges per frame: a restart chunk first, then only new edges; removal stops them', () => {
    const h = harness();
    // Added before load: the session keeps the probe and attaches it to every bench it loads.
    h.session.handle({ type: 'addProbe', key: 'uno:13', pin: { part: 'uno', pin: '13' } });
    h.session.handle({ type: 'addProbe', key: 'r1:1', pin: { part: 'r1', pin: '1' } }); // same net
    h.session.handle({ type: 'load', doc: project('blink-led'), firmware: { uno: hex('blink') } });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(1200);
    const chunks = h.frames().flatMap((f) => f.probes.filter((c) => c.key === 'uno:13'));
    expect(chunks[0]).toMatchObject({ from: 0, restart: true, lost: 0, peripheral: false });
    expect(chunks.slice(1).every((c) => !c.restart)).toBe(true);
    // Contiguous: each chunk starts where the previous one ended.
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].from).toBe(chunks[i - 1].from + chunks[i - 1].times.length);
    const times = chunks.flatMap((c) => Array.from(c.times));
    const levels = chunks.flatMap((c) => Array.from(c.levels));
    expect(levels).toEqual([2, 0, 1, 0, 1].slice(5 - levels.length));
    expect(Math.round(times.at(-1)! / NS_PER_MS)).toBe(1000);
    // Both keys see the same net.
    expect(h.frames().flatMap((f) => f.probes.filter((c) => c.key === 'r1:1')).flatMap((c) => Array.from(c.levels))).toEqual(levels);

    // Removing one key keeps the shared net recording for the other.
    h.session.handle({ type: 'removeProbe', key: 'r1:1' });
    const before = h.frames().length;
    h.advance(400);
    const later = h.frames().slice(before).flatMap((f) => f.probes);
    expect(later.every((c) => c.key === 'uno:13')).toBe(true);
    expect(later.flatMap((c) => Array.from(c.levels))).toEqual([0]); // D13 low at 1500 ms

    // Reset restarts the recording.
    h.session.handle({ type: 'reset' });
    h.advance(20);
    const restarted = h.frames().flatMap((f) => f.probes).filter((c) => c.restart).at(-1);
    expect(restarted).toMatchObject({ key: 'uno:13', from: 0 });
    expect(restarted?.times[0]).toBe(0);
  });

  it('debugger: info once per firmware, breakpoint stops, step, step over, memory, pause', () => {
    const h = harness();
    const of = <T extends FromSim['type']>(type: T) => h.messages.filter((m): m is Extract<FromSim, { type: T }> => m.type === type);
    const elf = { format: 'elf' as const, bytes: readFixture('fixtures/firmware/uno/debug-demo.elf') };
    h.session.handle({ type: 'load', doc: project('debug-demo'), firmware: { uno: elf } });
    const [info] = of('debugInfo');
    expect(info).toMatchObject({ board: 'uno', error: null });
    const symbols = new SymbolTable(info.symbols!);
    const lines = new LineTable(info.lines!);
    const addSlow = symbols.lookup('addSlow')!.address;
    expect(lines.addressToLine(addSlow)?.file).toMatch(/debug-demo\.ino$/);
    // A reload with the same firmware doesn't parse or send it again.
    h.session.handle({ type: 'load', doc: project('debug-demo'), firmware: { uno: { ...elf, bytes: elf.bytes.slice() } } });
    expect(of('debugInfo')).toHaveLength(1);

    h.session.handle({ type: 'debugSetBreakpoints', board: 'uno', specs: ['addSlow'] });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(100);
    const stop = of('debugStopped').at(-1)!;
    expect(stop).toMatchObject({ board: 'uno', reason: 'breakpoint', pc: addSlow });
    expect(stop.registers[24] + 256 * stop.registers[25]).toBe(1234);
    expect(h.frames().at(-1)?.running).toBe(false);

    h.session.handle({ type: 'debugStep', board: 'uno' });
    expect(of('debugStopped').at(-1)).toMatchObject({ reason: 'step', pc: addSlow + 2 });

    // Continue to the next hit, then step back out to the caller and over the next call.
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(300);
    expect(of('debugStopped').at(-1)).toMatchObject({ reason: 'breakpoint', pc: addSlow });
    expect(h.serialText('uno')).toContain('a=1234 counter=1');
    h.session.handle({ type: 'debugSetBreakpoints', board: 'uno', specs: [] });

    h.session.handle({ type: 'debugReadMemory', board: 'uno', space: 'data', addr: symbols.lookup('counter')!.address, len: 2 });
    const memory = of('debugMemory').at(-1)!;
    expect(memory.bytes[0] | (memory.bytes[1] << 8)).toBe(1);
    h.session.handle({ type: 'debugReadMemory', board: 'uno', space: 'data', addr: 0x8f8, len: 64 });
    expect(of('debugMemory').at(-1)?.bytes.length).toBe(8); // cut at the end of the data space

    h.session.handle({ type: 'run', speed: 1 });
    h.advance(50);
    h.session.handle({ type: 'debugPause' });
    expect(of('debugStopped').at(-1)).toMatchObject({ board: 'uno', reason: 'pause' });
    expect(h.frames().at(-1)?.running).toBe(false);
  });

  it('debugger: step over a call returns to the next instruction and restores the speed', () => {
    const h = harness();
    const of = <T extends FromSim['type']>(type: T) => h.messages.filter((m): m is Extract<FromSim, { type: T }> => m.type === type);
    const bytes = readFixture('fixtures/firmware/uno/debug-demo.elf');
    h.session.handle({ type: 'load', doc: project('debug-demo'), firmware: { uno: { format: 'elf', bytes } } });
    const symbols = new SymbolTable(of('debugInfo')[0].symbols!);
    const addSlow = symbols.lookup('addSlow')!.address;
    // Stop inside addSlow, step until its RET returns to the caller: that PC follows the call.
    h.session.handle({ type: 'debugSetBreakpoints', board: 'uno', specs: [`0x${addSlow.toString(16)}`] });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(100);
    const caller = of('debugStopped').at(-1)!;
    const returnSp = caller.registers[33] + 2;
    let stop = caller;
    for (let i = 0; i < 2000 && stop.registers[33] !== returnSp; i++) {
      h.session.handle({ type: 'debugStep', board: 'uno' });
      stop = of('debugStopped').at(-1)!;
    }
    const afterCall = stop.pc; // just after `call addSlow`
    // Run to the call itself on the next loop: break 4 bytes before the return address.
    h.session.handle({ type: 'debugSetBreakpoints', board: 'uno', specs: [`0x${(afterCall - 4).toString(16)}`] });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(300);
    expect(of('debugStopped').at(-1)).toMatchObject({ reason: 'breakpoint', pc: afterCall - 4 });
    h.session.handle({ type: 'debugStepOver', board: 'uno' });
    h.advance(20);
    const over = of('debugStopped').at(-1)!;
    expect(over).toMatchObject({ reason: 'step', pc: afterCall });
    expect(over.registers[33]).toBe(returnSp);
    // Back at the chosen speed: one second of wall time is about one simulated second.
    h.session.handle({ type: 'debugSetBreakpoints', board: 'uno', specs: [] });
    const t0 = h.frames().at(-1)!.t;
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(500);
    expect((h.frames().at(-1)!.t - t0) / NS_PER_MS).toBeCloseTo(500, -2);
  });

  it('debugger: breakpoints sent before a load are armed before its first instruction', () => {
    const h = harness();
    h.session.handle({ type: 'debugSetBreakpoints', board: 'uno', specs: ['addSlow', 'nope', 'debug-demo.ino:1'] });
    const elf = { format: 'elf' as const, bytes: readFixture('fixtures/firmware/uno/debug-demo.elf') };
    h.session.handle({ type: 'load', doc: project('debug-demo'), firmware: { uno: elf } });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(50);
    const stop = h.messages.filter((m) => m.type === 'debugStopped').at(-1);
    expect(stop).toMatchObject({ reason: 'breakpoint' });
    if (stop?.type === 'debugStopped') expect(stop.registers[24] + 256 * stop.registers[25]).toBe(1234);
    expect(h.serialText('uno')).toBe('');
  });
});
