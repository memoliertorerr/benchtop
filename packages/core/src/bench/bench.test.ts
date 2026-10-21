import { describe, expect, it } from 'vitest';
import type { I2cDevice } from '../contracts/bus.ts';
import type { BoardSpec, PartDefinition } from '../contracts/part.ts';
import { Strength } from '../contracts/signal.ts';
import { cyclesToNanos, NS_PER_MS, NS_PER_US } from '../contracts/time.ts';
import { FakeMcu, fakeBoard, makeBenchEnv, testDoc, toggleSteps } from '../testing.ts';
import { Bench } from './bench.ts';

/** Codes from the circuit checker (BT22), left out where a test is about other problems. */
const CHECKER_CODES = new Set(['unwired-part', 'unconnected-pins', 'unpowered-part', 'floating-input']);

const BOARD_PINS = ['D1', 'D2', 'SDA', 'SCL', 'SCK', 'MOSI', 'MISO'];
const board = fakeBoard('fake-board', BOARD_PINS);

/** Records every state change on IN with ctx.now(); 'press' drives OUT high and invalidates. */
const probe: PartDefinition = {
  type: 'probe',
  title: 'Probe',
  category: 'basic',
  size: { w: 5, h: 5 },
  pins: [
    { name: 'IN', x: 0, y: 0, role: 'digital' },
    { name: 'OUT', x: 2.54, y: 0, role: 'digital' },
  ],
  defaults: {},
  createModel(ctx) {
    const edges: { t: number; level: 0 | 1 | null }[] = [];
    let presses = 0;
    let resets = 0;
    ctx.pin('IN').onChange((state) => edges.push({ t: ctx.now(), level: state.level }));
    const out = ctx.pin('OUT');
    return {
      input(event) {
        if (event.kind === 'press') {
          presses++;
          out.drive(1);
          ctx.invalidate();
        }
      },
      visual: () => ({ presses, resets, edges: edges.length }),
      reset() {
        resets++;
        edges.length = 0;
      },
    };
  },
};

/** A ground terminal (a supply source at 0 V) and a module that only consumes power. */
const ground: PartDefinition = {
  type: 'ground',
  title: 'Ground',
  category: 'power',
  size: { w: 2, h: 2 },
  pins: [{ name: 'GND', x: 0, y: 0, role: 'ground', volts: 0 }],
  defaults: {},
};
const module: PartDefinition = {
  type: 'module',
  title: 'Module',
  category: 'sensors',
  size: { w: 5, h: 5 },
  pins: [
    { name: 'VCC', x: 0, y: 0, role: 'power' },
    { name: 'GND', x: 2.54, y: 0, role: 'ground' },
  ],
  defaults: {},
};

/** An I2C device on SDA/SCL and an SPI device selected by CS. */
const busPart: PartDefinition = {
  type: 'bus-part',
  title: 'Bus part',
  category: 'displays',
  size: { w: 10, h: 5 },
  pins: ['SDA', 'SCL', 'SCK', 'MOSI', 'MISO', 'CS'].map((name, i) => ({ name, x: i * 2.54, y: 0, role: 'digital' as const })),
  defaults: {},
  createModel(ctx) {
    const device: I2cDevice = { address: 0x3c, start: () => true, write: () => true, read: () => 0, stop: () => {} };
    ctx.attachI2c('SDA', 'SCL', device);
    ctx.attachSpi({ sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' }, { transfer: (b) => b ^ 0xff });
    return {};
  },
};

const definitions = [board, probe, ground, module, busPart];

function benchWith(doc: ReturnType<typeof testDoc>, mcu: FakeMcu) {
  return new Bench(doc, makeBenchEnv(definitions, () => mcu));
}

describe('Bench', () => {
  it('delivers MCU edges to part listeners with ctx.now() at the exact edge time', () => {
    // 16 MHz, first edge at 0.3 ms, then every 1 ms: the edges fall inside quanta, not on them.
    const mcu = new FakeMcu({ pins: BOARD_PINS, script: toggleSteps('D1', 4_800, 16_000, 10) });
    const bench = benchWith(testDoc({ uno: 'fake-board', p: 'probe' }, [['uno:D1', 'p:IN']]), mcu);
    const model = bench.collectFrame(); // nothing invalidated yet
    expect(model.parts).toEqual([]);
    bench.runUntil(10 * NS_PER_MS);
    bench.input('p', { kind: 'press' });
    // Read the recorded edges back through the model's visual state and the pin's inputs.
    const pin = mcu.pins.get('D1')!;
    const edgeInputs = pin.inputs.filter((s) => s.strength === Strength.strong);
    expect(edgeInputs.map((s) => s.level)).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    expect(bench.collectFrame().parts).toEqual([['p', { presses: 1, resets: 0, edges: 11 }]]);
  });

  it('drives an MCU pin\'s analog output (outputVolts, a DAC) at strong strength, and stops when it ends', () => {
    const mcu = new FakeMcu({ pins: BOARD_PINS, script: [] });
    const bench = benchWith(testDoc({ uno: 'fake-board', p: 'probe' }, [['uno:D1', 'p:IN']]), mcu);
    const pin = mcu.pins.get('D1')!;
    pin.setVolts(1.23);
    expect(bench.pinState('p', 'IN')).toMatchObject({ volts: 1.23, strength: Strength.strong, level: 0 });
    pin.setVolts(4.1); // ≥ half the 5 V logic supply: a digital 1
    expect(bench.pinState('p', 'IN')).toMatchObject({ volts: 4.1, level: 1 });
    pin.setVolts(undefined); // back to the mode: an input drives nothing
    expect(bench.pinState('p', 'IN')?.strength).toBe(Strength.hiz);
  });

  it('gives each listener the exact cycle time of every edge', () => {
    const times: number[] = [];
    const recorder: PartDefinition = {
      ...probe,
      type: 'recorder',
      createModel(ctx) {
        ctx.pin('IN').onChange((state) => {
          if (state.level !== null) times.push(ctx.now());
        });
        return {};
      },
    };
    const mcu = new FakeMcu({ pins: BOARD_PINS, script: toggleSteps('D1', 4_800, 16_000, 10) });
    const bench = new Bench(
      testDoc({ uno: 'fake-board', r: 'recorder' }, [['uno:D1', 'r:IN']]),
      makeBenchEnv([board, recorder], () => mcu),
    );
    bench.runUntil(10 * NS_PER_MS);
    expect(times).toEqual(Array.from({ length: 10 }, (_, i) => 0.3 * NS_PER_MS + i * NS_PER_MS));
  });

  it('runs a 16 MHz and a 240 MHz MCU to within one cycle of the target', () => {
    const esp = fakeBoard('fake-esp', BOARD_PINS, 'esp32');
    const made: FakeMcu[] = [];
    const createMcu = (spec: BoardSpec) => {
      const mcu = new FakeMcu({ pins: BOARD_PINS, kind: spec.mcu, clockHz: spec.mcu === 'esp32' ? 240_000_000 : 16_000_000 });
      made.push(mcu);
      return mcu;
    };
    const bench = new Bench(testDoc({ uno: 'fake-board', esp: 'fake-esp' }), makeBenchEnv([board, esp], createMcu));
    expect(bench.quantum).toBe(100 * NS_PER_US);
    bench.runUntil(5 * NS_PER_MS);
    for (const mcu of made) {
      const reached = cyclesToNanos(mcu.cycles, mcu.clockHz);
      expect(Math.abs(reached - 5 * NS_PER_MS)).toBeLessThanOrEqual(cyclesToNanos(1, mcu.clockHz));
    }
    expect(made.map((m) => m.cycles)).toEqual([80_000, 1_200_000]);
    expect(bench.now()).toBe(5 * NS_PER_MS);
  });

  it('drives nets from supply pins but not from consumer power pins', () => {
    const mcu = new FakeMcu({ pins: BOARD_PINS });
    const bench = benchWith(
      testDoc({ uno: 'fake-board', m1: 'module', m2: 'module' }, [
        ['uno:5V', 'm1:VCC'],
        ['uno:GND', 'm1:GND'],
      ]),
      mcu,
    );
    expect(bench.pinState('m1', 'VCC')).toEqual({ level: 1, strength: Strength.supply, conflict: false, volts: 5 });
    expect(bench.pinState('m1', 'GND')).toEqual({ level: 0, strength: Strength.supply, conflict: false, volts: 0 });
    expect(bench.pinState('m2', 'VCC')).toEqual({ level: null, strength: Strength.hiz, conflict: false, volts: 0 });
    expect(bench.pinState('m2', 'nope')).toBeUndefined();
  });

  it('reports a drive fight (MCU output 1 wired to a GND pin) naming both parts', () => {
    const mcu = new FakeMcu({ pins: BOARD_PINS, script: [{ cycle: 160, pin: 'D2', mode: 'output', level: 1 }] });
    const bench = benchWith(testDoc({ uno: 'fake-board', gnd: 'ground' }, [['uno:D2', 'gnd:GND']]), mcu);
    expect(bench.problems()).toEqual([]);
    bench.runUntil(NS_PER_MS);
    // A conflict against a supply is a drive fight (BT22); between outputs it would be a short.
    const fights = bench.problems().filter((p) => p.code === 'drive-fight');
    expect(fights).toHaveLength(1);
    expect(fights[0].severity).toBe('error');
    expect(fights[0].parts).toEqual(['gnd', 'uno']);
    expect(mcu.pins.get('D2')!.lastInput()).toMatchObject({ level: 0, conflict: true });
  });

  it('collects frames only from parts that invalidated since the previous frame', () => {
    const mcu = new FakeMcu({ pins: BOARD_PINS });
    const bench = benchWith(testDoc({ uno: 'fake-board', a: 'probe', b: 'probe', c: 'probe' }), mcu);
    bench.input('b', { kind: 'press' });
    bench.input('b', { kind: 'press' });
    bench.input('c', { kind: 'press' });
    expect(bench.collectFrame().parts.map(([id]) => id)).toEqual(['b', 'c']);
    expect(bench.collectFrame().parts).toEqual([]);
    expect(() => bench.input('zz', { kind: 'press' })).toThrow('no part "zz"');
  });

  it('fires part timers at their exact time with every MCU caught up to it', () => {
    let fired = -1;
    let mcuTime = -1;
    const timed: PartDefinition = {
      ...probe,
      type: 'timed',
      createModel(ctx) {
        ctx.schedule(2.5 * NS_PER_MS + 7, () => {
          fired = ctx.now();
          mcuTime = cyclesToNanos(mcu.cycles, mcu.clockHz);
        });
        const dropped = ctx.schedule(NS_PER_MS, () => {
          fired = -2;
        });
        ctx.cancel(dropped);
        return {};
      },
    };
    const mcu = new FakeMcu({ pins: BOARD_PINS });
    const bench = new Bench(testDoc({ uno: 'fake-board', t: 'timed' }), makeBenchEnv([board, timed], () => mcu));
    bench.runUntil(3 * NS_PER_MS);
    expect(fired).toBe(2.5 * NS_PER_MS + 7);
    // nanosToCycles rounds down: the MCU is within one 62.5 ns cycle of the timer.
    expect(2.5 * NS_PER_MS + 7 - mcuTime).toBeLessThan(62.5);
  });

  it('batches serial output per quantum and delivers serial input', () => {
    const mcu = new FakeMcu({
      pins: BOARD_PINS,
      script: [
        { cycle: 100, tx: [0x68, 0x69] },
        { cycle: 200, tx: [0x0a] },
        { cycle: 20_000, tx: [0x21] }, // 1.25 ms: the next quantum
      ],
    });
    const bench = benchWith(testDoc({ uno: 'fake-board' }), mcu);
    const batches: number[][] = [];
    bench.onSerial('uno', (bytes) => batches.push([...bytes]));
    bench.runUntil(2 * NS_PER_MS);
    expect(batches).toEqual([[0x68, 0x69, 0x0a], [0x21]]);
    bench.sendSerial('uno', new Uint8Array([1, 2]));
    expect(mcu.uart0.received).toEqual([1, 2]);
    expect(() => bench.onSerial('nope', () => {})).toThrow('no MCU board');
  });

  it('attaches bus devices to the controller on their nets, and reports unattached ones', () => {
    const mcu = new FakeMcu({
      pins: BOARD_PINS,
      script: [{ cycle: 16, pin: 'D1', mode: 'output', level: 1 }],
      i2c: [{ sda: 'SDA', scl: 'SCL' }],
      spi: [{ sck: 'SCK', mosi: 'MOSI', miso: 'MISO' }],
    });
    const bench = benchWith(
      testDoc({ uno: 'fake-board', dev: 'bus-part', lost: 'bus-part' }, [
        ['uno:SDA', 'dev:SDA'],
        ['uno:SCL', 'dev:SCL'],
        ['uno:SCK', 'dev:SCK'],
        ['uno:MOSI', 'dev:MOSI'],
        ['uno:MISO', 'dev:MISO'],
        ['uno:D1', 'dev:CS'],
      ]),
      mcu,
    );
    expect(mcu.i2cControllers[0].attached.map((d) => d.address)).toEqual([0x3c]);
    const spi = mcu.spiControllers[0].attached;
    expect(spi).toHaveLength(1);
    expect(spi[0].device.transfer(0x0f)).toBe(0xf0);
    expect(spi[0].selected()).toBe(false); // CS floating
    bench.runUntil(NS_PER_MS);
    expect(spi[0].selected()).toBe(false); // CS high
    // (The circuit checker's static infos — unwired 'lost', unused pins — are BT22's tests.)
    expect(bench.problems().filter((p) => !CHECKER_CODES.has(p.code)).map((p) => [p.code, p.severity, p.parts])).toEqual([
      ['i2c-unattached', 'info', ['lost']],
      ['spi-unattached', 'info', ['lost']],
    ]);
  });

  it('resets time, timers, MCUs and part models', () => {
    let fired = 0;
    const timed: PartDefinition = {
      ...probe,
      type: 'timed',
      createModel(ctx) {
        ctx.schedule(5 * NS_PER_MS, () => fired++);
        return {};
      },
    };
    const mcu = new FakeMcu({ pins: BOARD_PINS, script: toggleSteps('D1', 1_000, 16_000, 3) });
    const bench = new Bench(
      testDoc({ uno: 'fake-board', p: 'probe', t: 'timed' }, [['uno:D1', 'p:IN']]),
      makeBenchEnv([board, probe, timed], () => mcu),
    );
    bench.runUntil(2 * NS_PER_MS);
    expect(mcu.pins.get('D1')!.mode()).toBe('output');
    bench.reset();
    expect(bench.now()).toBe(0);
    expect(mcu.resets).toBe(1);
    expect(mcu.pins.get('D1')!.mode()).toBe('input');
    expect(bench.pinState('p', 'IN')).toMatchObject({ level: null });
    bench.runUntil(10 * NS_PER_MS);
    expect(fired).toBe(0); // the timer from before the reset is gone
    expect(bench.collectFrame().parts).toContainEqual(['p', { presses: 0, resets: 1, edges: 4 }]);
  });

  it('attaches firmware, restarting that MCU at bench time', () => {
    const mcu = new FakeMcu({ pins: BOARD_PINS });
    const bench = benchWith(testDoc({ uno: 'fake-board' }), mcu);
    bench.runUntil(3 * NS_PER_MS);
    bench.attachFirmware('uno', { format: 'hex', text: ':00000001FF' });
    expect(mcu.loaded).toEqual({ format: 'hex', text: ':00000001FF' });
    expect(mcu.cycles).toBe(0);
    bench.runUntil(4 * NS_PER_MS);
    expect(mcu.cycles).toBe(16_000); // 1 ms since the load
  });

  it('measures MCU edges through a resistor to a part listener (throughput, no timing assertion)', () => {
    const resistor: PartDefinition = {
      type: 'resistor',
      title: 'Resistor',
      category: 'basic',
      size: { w: 10, h: 2 },
      pins: [
        { name: '1', x: 0, y: 0, role: 'passive' },
        { name: '2', x: 10, y: 0, role: 'passive' },
      ],
      links: [{ id: 'r', a: '1', b: '2', kind: 'resistive', ohms: 220 }],
      defaults: {},
    };
    const edges = 200_000;
    // One edge every 40 cycles (2.5 µs at 16 MHz): 0.5 s of simulated time.
    const mcu = new FakeMcu({ pins: BOARD_PINS, script: toggleSteps('D1', 40, 40, edges) });
    let seen = 0;
    const counter: PartDefinition = {
      ...probe,
      type: 'counter',
      createModel(ctx) {
        ctx.pin('IN').onChange((state) => {
          if (state.level !== null) seen++;
        });
        return {};
      },
    };
    const bench = new Bench(
      testDoc({ uno: 'fake-board', r: 'resistor', c: 'counter' }, [
        ['uno:D1', 'r:1'],
        ['r:2', 'c:IN'],
      ]),
      makeBenchEnv([board, resistor, counter], () => mcu),
    );
    const start = performance.now();
    bench.runUntil(500 * NS_PER_MS);
    const ms = performance.now() - start;
    console.info(`bench: ${edges} MCU edges through a resistor in ${ms.toFixed(0)} ms = ${Math.round((edges / ms) * 1000).toLocaleString('en-US')} edges/s`);
    expect(seen).toBe(edges);
    expect(bench.pinState('c', 'IN')).toMatchObject({ level: 0, strength: Strength.weak });
  });

  it('reports unknown types, unresolved wires, missing MCUs and stopped MCUs', () => {
    const doc = testDoc({ uno: 'fake-board', x: 'mystery', m: 'module' }, [
      ['uno:D1', 'm:NOPE'],
      ['x:1', 'm:VCC'],
    ]);
    const noMcu = new Bench(doc, makeBenchEnv(definitions));
    expect(noMcu.problems().filter((p) => !CHECKER_CODES.has(p.code)).map((p) => [p.code, p.parts])).toEqual([
      ['unknown-part-type', ['x']],
      ['unresolved-wire', ['m']],
      ['unresolved-wire', ['x']],
      ['mcu-unavailable', ['uno']],
    ]);

    const faulty = new FakeMcu({ pins: BOARD_PINS, script: [{ cycle: 50, stop: { reason: 'fault', detail: 'bad opcode' } }] });
    const bench = benchWith(testDoc({ uno: 'fake-board' }), faulty);
    bench.runUntil(NS_PER_MS);
    expect(bench.problems()).toEqual([
      { severity: 'error', code: 'mcu-fault', message: 'The MCU on "uno" stopped (fault): bad opcode', parts: ['uno'] },
    ]);
    bench.runUntil(2 * NS_PER_MS);
    expect(faulty.cycles).toBe(50); // a stopped MCU stays stopped until reset
  });
});
