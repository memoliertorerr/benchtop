import { NS_PER_MS, type PartInstance, type ProjectDoc, SymbolTable, type Wire } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import type { FromSim } from './protocol.ts';
import { SimSession } from './session.ts';

// BT79: edits reach a loaded session as `edit` — the bench is rebuilt with carry-over, so time,
// the running boards and unchanged parts continue.

type Frame = Extract<FromSim, { type: 'frame' }>;

function harness(sharedMemory = false) {
  let wall = 0;
  let pending: (() => void) | null = null;
  const messages: FromSim[] = [];
  const session = new SimSession({
    post: (message) => messages.push(message.type === 'frameRing' ? message : structuredClone(message)),
    now: () => wall,
    schedule: (fn) => {
      pending = fn;
    },
    sharedMemory,
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
  const of = <T extends FromSim['type']>(type: T) => messages.filter((m): m is Extract<FromSim, { type: T }> => m.type === type);
  const frames = () => of('frame') as Frame[];
  const serialText = (board: string) =>
    of('serial')
      .filter((m) => m.board === board)
      .map((m) => String.fromCharCode(...m.bytes))
      .join('');
  return { session, messages, advance, of, frames, serialText };
}

const project = (name: string): ProjectDoc => JSON.parse(readFixtureText(`fixtures/projects/${name}.json`));
const hex = (name: string) => ({ format: 'hex' as const, text: readFixtureText(`fixtures/firmware/uno/${name}.hex`) });
const part = (id: string, type: string, x: number, y: number, props: PartInstance['props'] = {}): PartInstance => ({ id, type, x, y, rotation: 0, props });
const wire = (id: string, a: [string, string], b: [string, string]): Wire => ({ id, from: { part: a[0], pin: a[1] }, to: { part: b[0], pin: b[1] }, waypoints: [], color: 'green' });

/** `doc` plus an LED and resistor from the Uno's pin 13 to GND.2, away from everything. */
function withLed(doc: ProjectDoc): ProjectDoc {
  return {
    ...doc,
    parts: [...doc.parts, part('rx', 'resistor', 300, 200, { ohms: 220 }), part('ledx', 'led', 340, 200, { color: 'red' })],
    wires: [...doc.wires, wire('wx1', ['uno', '13'], ['rx', '1']), wire('wx2', ['rx', '2'], ['ledx', 'A']), wire('wx3', ['ledx', 'C'], ['uno', 'GND.2'])],
  };
}

const lit = (frames: Frame[], id: string) => frames.flatMap((f) => f.parts.filter(([p]) => p === id).map(([, v]) => ({ t: f.t / NS_PER_MS, on: (v.brightness as number) > 0.5 })));

describe('SimSession edit (BT79)', () => {
  it('a running blink gets an LED: time, serial and the probe go on; the new LED follows the sketch', () => {
    const h = harness();
    h.session.handle({ type: 'addProbe', key: 'uno:13', pin: { part: 'uno', pin: '13' } });
    h.session.handle({ type: 'load', doc: project('blink-led'), firmware: { uno: hex('blink') } });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(1200);
    const framesBefore = h.frames().length;
    h.session.handle({ type: 'edit', doc: withLed(project('blink-led')), firmware: { uno: hex('blink') } });
    expect(h.of('edited').at(-1)).toEqual({ type: 'edited', problems: [], reloaded: false });
    const first = h.frames()[framesBefore];
    expect(first.t / NS_PER_MS).toBeCloseTo(1200, -1); // not back to 0
    expect(first.running).toBe(true);
    // the first frame after the edit carries every part (the kept LED's state too)
    expect(first.parts.map(([id]) => id).sort()).toEqual(['led1', 'ledx', 'uno']);
    h.advance(1400);
    expect(h.serialText('uno')).toBe('hello\r\n'); // no second boot
    const after = h.frames().slice(framesBefore);
    const edges = (id: string) => lit(after, id).filter((l, i, all) => i === 0 || l.on !== all[i - 1].on);
    // the sketch's schedule, uninterrupted: on until 1500, off until 2000, on until 2500
    for (const id of ['led1', 'ledx']) {
      const e = edges(id);
      expect(e.map((l) => l.on)).toEqual([true, false, true, false]);
      expect(Math.abs(e[1].t - 1500)).toBeLessThanOrEqual(16);
      expect(Math.abs(e[2].t - 2000)).toBeLessThanOrEqual(16);
    }
    // The probe: no restart; the edges after the edit still come.
    const chunks = after.flatMap((f) => f.probes.filter((c) => c.key === 'uno:13'));
    expect(chunks.every((c) => !c.restart)).toBe(true);
    const times = chunks.flatMap((c) => Array.from(c.times)).map((t) => Math.round(t / NS_PER_MS));
    expect(times).toContain(1500);
    expect(times).toContain(2000);
    expect(h.of('loaded')).toHaveLength(1);
  });

  it('a paused bench stays paused and continues from where it was', () => {
    const h = harness();
    h.session.handle({ type: 'load', doc: project('blink-led'), firmware: { uno: hex('blink') } });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(700);
    h.session.handle({ type: 'pause' });
    const paused = h.frames().at(-1)!.t;
    h.session.handle({ type: 'edit', doc: withLed(project('blink-led')), firmware: { uno: hex('blink') } });
    expect(h.frames().at(-1)).toMatchObject({ t: paused, running: false });
    h.advance(200);
    expect(h.frames().at(-1)?.t).toBe(paused);
    h.session.handle({ type: 'step', ns: 10 * NS_PER_MS });
    expect(h.frames().at(-1)?.t).toBe(paused + 10 * NS_PER_MS);
  });

  it('a board stopped at a breakpoint stays there: same PC, steps on; its symbols aren\'t sent again', () => {
    const h = harness();
    const elf = { format: 'elf' as const, bytes: readFixture('fixtures/firmware/uno/debug-demo.elf') };
    h.session.handle({ type: 'load', doc: project('debug-demo'), firmware: { uno: elf } });
    const symbols = new SymbolTable(h.of('debugInfo')[0].symbols!);
    const addSlow = symbols.lookup('addSlow')!.address;
    h.session.handle({ type: 'debugSetBreakpoints', board: 'uno', specs: ['addSlow'] });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(100);
    expect(h.of('debugStopped').at(-1)).toMatchObject({ reason: 'breakpoint', pc: addSlow });
    const stops = h.of('debugStopped').length;
    h.session.handle({ type: 'edit', doc: withLed(project('debug-demo')), firmware: { uno: elf } });
    expect(h.of('debugStopped')).toHaveLength(stops); // nothing changed for the kept board
    expect(h.of('debugInfo')).toHaveLength(1);
    expect(h.frames().at(-1)?.running).toBe(false);
    h.session.handle({ type: 'debugStep', board: 'uno' });
    expect(h.of('debugStopped').at(-1)).toMatchObject({ reason: 'step', pc: addSlow + 2 });
  });

  it('keeps the frame ring while the part list is the same; a new part list gets a new ring', () => {
    const h = harness(true);
    const doc = project('blink-led');
    h.session.handle({ type: 'load', doc, firmware: { uno: hex('blink') } });
    expect(h.of('frameRing')).toHaveLength(1);
    // Rewired, same parts: the LED's anode moves to pin 12.
    const rewired: ProjectDoc = { ...doc, wires: [...doc.wires, wire('wy', ['uno', '12'], ['led1', 'A'])] };
    h.session.handle({ type: 'edit', doc: rewired, firmware: { uno: hex('blink') } });
    expect(h.of('frameRing')).toHaveLength(1);
    h.session.handle({ type: 'edit', doc: withLed(rewired), firmware: { uno: hex('blink') } });
    expect(h.of('frameRing')).toHaveLength(2);
    expect(h.of('frameRing')[1].parts).toEqual(withLed(rewired).parts.map((p) => p.id));
  });

  it('an invalid document is an error and leaves the bench running as it was', () => {
    const h = harness();
    h.session.handle({ type: 'load', doc: project('blink-led'), firmware: { uno: hex('blink') } });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(300);
    h.session.handle({ type: 'edit', doc: { ...project('blink-led'), parts: [part('BAD ID', 'led', 0, 0)] }, firmware: {} });
    expect(h.messages.at(-1)).toMatchObject({ type: 'error' });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(300);
    expect(h.frames().at(-1)!.t / NS_PER_MS).toBeGreaterThan(500);
    expect(h.serialText('uno')).toBe('hello\r\n');
  });

  it('a new board in an edit starts its firmware at the edit; a removed one goes', () => {
    const h = harness();
    const doc = project('blink-led');
    h.session.handle({ type: 'load', doc, firmware: { uno: hex('blink') } });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(600);
    const two: ProjectDoc = { ...doc, parts: [...doc.parts, part('uno2', 'arduino-uno', 0, 120)], firmware: { ...doc.firmware, uno2: { kind: 'file', name: 'blink.hex', format: 'hex' } } };
    h.session.handle({ type: 'edit', doc: two, firmware: { uno: hex('blink'), uno2: hex('blink') } });
    h.advance(300);
    expect(h.serialText('uno')).toBe('hello\r\n');
    expect(h.serialText('uno2')).toBe('hello\r\n');
    expect(h.of('debugInfo').filter((m) => m.board === 'uno2')).toHaveLength(1);
    h.session.handle({ type: 'edit', doc, firmware: { uno: hex('blink') } });
    h.advance(300);
    expect(h.messages.filter((m) => m.type === 'error')).toEqual([]);
    expect(h.frames().at(-1)!.stats.mhz.uno2).toBeUndefined();
  });
});
