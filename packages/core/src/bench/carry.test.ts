import { describe, expect, it } from 'vitest';
import type { I2cDevice } from '../contracts/bus.ts';
import type { BoardSpec, PartDefinition, VisualState } from '../contracts/part.ts';
import type { ProjectDoc } from '../contracts/project.ts';
import { Strength } from '../contracts/signal.ts';
import { NS_PER_MS } from '../contracts/time.ts';
import { FakeMcu, fakeBoard, makeBenchEnv, testDoc, toggleSteps } from '../testing.ts';
import { assembleBench } from './assemble.ts';
import { Bench, type BenchEnv } from './bench.ts';

// BT78: a rebuild that carries time, timers, MCUs and unchanged part models over.

const BOARD_PINS = ['D1', 'D2', 'D3', 'SDA', 'SCL'];
const board = fakeBoard('fake-board', BOARD_PINS);

/** Records the time of every IN change; 'press' drives OUT high, 'release' releases it. */
const probe: PartDefinition = {
  type: 'probe',
  title: 'Probe',
  category: 'basic',
  size: { w: 5, h: 5 },
  pins: [
    { name: 'IN', x: 0, y: 0, role: 'digital' },
    { name: 'OUT', x: 2.54, y: 0, role: 'digital' },
  ],
  defaults: { tag: 'a' },
  createModel(ctx) {
    const edges: number[] = [];
    let last: number | null = null;
    const out = ctx.pin('OUT');
    ctx.pin('IN').onChange((state) => {
      if (state.level === last) return;
      last = state.level;
      if (state.level !== null) edges.push(ctx.now());
    });
    return {
      input(event) {
        if (event.kind === 'press') out.drive(1);
        if (event.kind === 'release') out.release();
        ctx.invalidate();
      },
      visual: (): VisualState => ({ edges: edges.join(',') }),
    };
  },
};

/** Fires one timer `delay` props ms after it starts; remembers when, and whether it was disposed. */
const fired = new Map<string, number>();
const disposed = new Set<string>();
const timer: PartDefinition = {
  type: 'timer',
  title: 'Timer',
  category: 'basic',
  size: { w: 5, h: 5 },
  pins: [{ name: 'X', x: 0, y: 0, role: 'digital' }],
  defaults: { name: '', delay: 7 },
  createModel(ctx, props) {
    const name = String(props.name);
    ctx.schedule(Number(props.delay) * NS_PER_MS, () => fired.set(name, ctx.now()));
    return { dispose: () => disposed.add(name) };
  },
};

/** A switch between A and B that 'press' closes. */
const toggle: PartDefinition = {
  type: 'toggle',
  title: 'Toggle',
  category: 'basic',
  size: { w: 5, h: 5 },
  pins: [
    { name: 'A', x: 0, y: 0, role: 'digital' },
    { name: 'B', x: 2.54, y: 0, role: 'digital' },
  ],
  links: [{ id: 'sw', a: 'A', b: 'B', kind: 'switch' }],
  defaults: {},
  createModel(ctx) {
    const sw = ctx.link('sw');
    return { input: (event) => sw.setClosed(event.kind === 'press') };
  },
};

/** An I2C device on SDA/SCL. */
const device: I2cDevice = { address: 0x3c, start: () => true, write: () => true, read: () => 0, stop: () => {} };
const i2cPart: PartDefinition = {
  type: 'i2c-part',
  title: 'I2C part',
  category: 'displays',
  size: { w: 5, h: 5 },
  pins: [
    { name: 'SDA', x: 0, y: 0, role: 'digital' },
    { name: 'SCL', x: 2.54, y: 0, role: 'digital' },
  ],
  defaults: {},
  createModel(ctx) {
    ctx.attachI2c('SDA', 'SCL', device);
    return {};
  },
};

const definitions = [board, probe, timer, toggle, i2cPart];

/** An env whose boards get FakeMcus from `scripts` (by part id); `made` lists every MCU created. */
function env(scripts: Record<string, ReturnType<typeof toggleSteps>> = {}): BenchEnv & { made: Map<string, FakeMcu[]> } {
  const made = new Map<string, FakeMcu[]>();
  const base = makeBenchEnv(definitions, (_board: BoardSpec, partId: string) => {
    const mcu = new FakeMcu({ pins: BOARD_PINS, script: scripts[partId] ?? [], i2c: [{ sda: 'SDA', scl: 'SCL' }] });
    made.set(partId, [...(made.get(partId) ?? []), mcu]);
    return mcu;
  });
  return Object.assign(base, { made });
}

const edgesOf = (bench: Bench, part: string): string => {
  const entry = bench.collectFrame().parts.find(([id]) => id === part);
  return String(entry?.[1].edges ?? '');
};

function rebuilt(doc: ProjectDoc, e: BenchEnv, old: Bench): Bench {
  return new Bench(doc, e, { carry: old.carry() });
}

describe('Bench.carry', () => {
  it('keeps time, the running MCU and a model whose pin moved to another net', () => {
    // D1 toggles every 1 ms from 0.3 ms, D2 every 1 ms from 0.6 ms (16 MHz).
    const e = env({ uno: [...toggleSteps('D1', 4_800, 16_000, 20), ...toggleSteps('D2', 9_600, 16_000, 20)].sort((a, b) => a.cycle - b.cycle) });
    const doc1 = testDoc({ uno: 'fake-board', p: 'probe' }, [['uno:D1', 'p:IN']]);
    const bench1 = new Bench(doc1, e);
    bench1.runUntil(5 * NS_PER_MS);
    const mcu = e.made.get('uno')?.[0] as FakeMcu;
    expect(mcu.cycles).toBe(80_000);

    // The probe's wire moves from D1 to D2.
    const bench2 = rebuilt(testDoc({ uno: 'fake-board', p: 'probe' }, [['uno:D2', 'p:IN']]), e, bench1);
    expect(e.made.get('uno')).toHaveLength(1); // no new MCU
    expect(mcu.resets).toBe(0);
    expect(bench2.carriedBoard('uno')).toBe(true);
    expect(bench2.now()).toBe(5 * NS_PER_MS);
    expect(() => bench1.runUntil(6 * NS_PER_MS)).toThrow(/carried over/);
    bench2.runUntil(8 * NS_PER_MS);
    expect(mcu.cycles).toBe(128_000);
    const edges = edgesOf(bench2, 'p').split(',').map(Number);
    // D1's edges before the edit (0.3 … 4.3 ms), D2's level at the edit, then D2's edges
    expect(edges.slice(0, 5)).toEqual([0.3, 1.3, 2.3, 3.3, 4.3].map((ms) => ms * NS_PER_MS));
    expect(edges.filter((t) => t > 5 * NS_PER_MS)).toEqual([5.6, 6.6, 7.6].map((ms) => ms * NS_PER_MS));
  });

  it('keeps a kept model\'s timers, drops a removed one\'s (disposing it), starts an added one now', () => {
    fired.clear();
    disposed.clear();
    const e = env();
    const doc1 = testDoc({ uno: 'fake-board', t1: 'timer', t2: 'timer' }, [], { t1: { name: 't1' }, t2: { name: 't2' } });
    const bench1 = new Bench(doc1, e);
    bench1.runUntil(5 * NS_PER_MS);
    const doc2 = testDoc({ uno: 'fake-board', t1: 'timer', t3: 'timer' }, [], { t1: { name: 't1' }, t3: { name: 't3' } });
    const bench2 = rebuilt(doc2, e, bench1);
    expect(disposed).toEqual(new Set(['t2']));
    bench2.runUntil(20 * NS_PER_MS);
    expect(fired.get('t1')).toBe(7 * NS_PER_MS); // on time, scheduled by bench 1
    expect(fired.has('t2')).toBe(false);
    expect(fired.get('t3')).toBe(12 * NS_PER_MS); // created at 5 ms
  });

  it('builds a model fresh when its props change', () => {
    fired.clear();
    disposed.clear();
    const e = env();
    const bench1 = new Bench(testDoc({ uno: 'fake-board', t1: 'timer' }, [], { t1: { name: 't1', delay: 7 } }), e);
    bench1.runUntil(5 * NS_PER_MS);
    const bench2 = rebuilt(testDoc({ uno: 'fake-board', t1: 'timer' }, [], { t1: { name: 't1', delay: 2 } }), e, bench1);
    expect(disposed).toEqual(new Set(['t1']));
    bench2.runUntil(20 * NS_PER_MS);
    expect(fired.get('t1')).toBe(7 * NS_PER_MS); // the new model's: 5 + 2
  });

  it('re-applies a kept model\'s drive and link setting on the new nets', () => {
    const e = env();
    const doc1 = testDoc({ uno: 'fake-board', p: 'probe', sw: 'toggle', q: 'probe' }, [
      ['p:OUT', 'q:IN'],
      ['uno:5V', 'sw:A'],
    ]);
    const bench1 = new Bench(doc1, e);
    bench1.input('p', { kind: 'press' }); // p drives OUT high
    bench1.input('sw', { kind: 'press' }); // the switch closes
    bench1.runUntil(1 * NS_PER_MS);
    expect(bench1.pinState('q', 'IN')?.level).toBe(1);
    // Rewired: p's OUT now reaches uno:D1, and the switch's B side a new probe r.
    const doc2 = testDoc({ uno: 'fake-board', p: 'probe', sw: 'toggle', q: 'probe', r: 'probe' }, [
      ['p:OUT', 'uno:D1'],
      ['uno:5V', 'sw:A'],
      ['sw:B', 'r:IN'],
    ]);
    const bench2 = rebuilt(doc2, e, bench1);
    expect(bench2.pinState('uno', 'D1')).toMatchObject({ level: 1, strength: Strength.strong });
    expect(bench2.pinState('r', 'IN')).toMatchObject({ level: 1, strength: Strength.supply });
    expect(bench2.pinState('q', 'IN')?.strength).toBe(Strength.hiz); // q kept, now unwired
    const d1 = (e.made.get('uno')?.[0] as FakeMcu).pins.get('D1');
    expect(d1?.inputs.at(-1)?.level).toBe(1);
  });

  it('a kept MCU sees the settled state, not the build: no glitch on its input', () => {
    const e = env();
    const doc1 = testDoc({ uno: 'fake-board', p: 'probe' }, [['p:OUT', 'uno:D2']]);
    const bench1 = new Bench(doc1, e);
    bench1.input('p', { kind: 'press' });
    bench1.runUntil(1 * NS_PER_MS);
    const d2 = (e.made.get('uno')?.[0] as FakeMcu).pins.get('D2');
    const before = d2?.inputs.length ?? 0;
    const bench2 = rebuilt(testDoc({ uno: 'fake-board', p: 'probe', q: 'probe' }, [['p:OUT', 'uno:D2']]), e, bench1);
    bench2.runUntil(2 * NS_PER_MS);
    const after = d2?.inputs.slice(before) ?? [];
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((s) => s.level === 1 && s.strength === Strength.strong)).toBe(true);
  });

  it('re-attaches a kept part\'s I2C device to the kept controller, once', () => {
    const e = env();
    const doc1 = testDoc({ uno: 'fake-board', oled: 'i2c-part' }, [
      ['uno:SDA', 'oled:SDA'],
      ['uno:SCL', 'oled:SCL'],
    ]);
    const bench1 = new Bench(doc1, e);
    const controller = (e.made.get('uno')?.[0] as FakeMcu).i2cControllers[0];
    expect(controller.attached).toEqual([device]);
    const bench2 = rebuilt({ ...doc1, parts: [...doc1.parts, ...testDoc({ p: 'probe' }).parts.map((p) => ({ ...p, x: 100 }))] }, e, bench1);
    expect(controller.attached).toEqual([device]);
    expect(bench2.problems().some((p) => p.code === 'i2c-unattached')).toBe(false);
  });

  it('a new board starts from reset at the carried time; a board whose firmware changed gets a new MCU', () => {
    const scripts = { uno: toggleSteps('D1', 4_800, 16_000, 20), uno2: toggleSteps('D1', 4_800, 16_000, 20) };
    const e = env(scripts);
    const fw = { format: 'hex', text: ':00000001FF' } as const;
    const doc1: ProjectDoc = { ...testDoc({ uno: 'fake-board', p: 'probe' }, [['uno:D1', 'p:IN']]), firmware: { uno: { kind: 'file', name: 'a.hex', format: 'hex' } } };
    const bench1 = assembleBench(doc1, e, { uno: fw });
    bench1.runUntil(5 * NS_PER_MS);
    const first = e.made.get('uno')?.[0] as FakeMcu;
    expect(first.resets).toBe(2); // load + the assembly's reset

    const doc2: ProjectDoc = {
      ...testDoc({ uno: 'fake-board', p: 'probe', uno2: 'fake-board', p2: 'probe' }, [
        ['uno:D1', 'p:IN'],
        ['uno2:D1', 'p2:IN'],
      ]),
      firmware: { uno: { kind: 'file', name: 'a.hex', format: 'hex' }, uno2: { kind: 'file', name: 'b.hex', format: 'hex' } },
    };
    const bench2 = assembleBench(doc2, e, { uno: fw, uno2: fw }, { carry: bench1.carry() });
    expect(first.resets).toBe(2); // kept: neither loaded nor reset
    expect(bench2.carriedBoard('uno2')).toBe(false);
    bench2.runUntil(8 * NS_PER_MS);
    const p2 = edgesOf(bench2, 'p2').split(',').map(Number);
    expect(p2).toEqual([5.3, 6.3, 7.3].map((ms) => ms * NS_PER_MS)); // its own 0.3 ms, after 5 ms

    const doc3: ProjectDoc = { ...doc2, firmware: { ...doc2.firmware, uno: { kind: 'file', name: 'c.hex', format: 'hex' } } };
    const bench3 = assembleBench(doc3, e, { uno: fw, uno2: fw }, { carry: bench2.carry() });
    expect(e.made.get('uno')).toHaveLength(2);
    expect(bench3.carriedBoard('uno')).toBe(false);
    expect(bench3.carriedBoard('uno2')).toBe(true);
  });
});
