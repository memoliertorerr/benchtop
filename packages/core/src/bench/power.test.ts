import { describe, expect, it } from 'vitest';
import type { PartDefinition, PartInput } from '../contracts/part.ts';
import { Strength } from '../contracts/signal.ts';
import { FakeMcu, type FakeStep, fakeBoard, makeBenchEnv, testDoc } from '../testing.ts';
import { Bench } from './bench.ts';
import { NS_PER_MS, NS_PER_US } from '../contracts/time.ts';

// BT200: a board whose model reports `power` — its MCU halts and its pins float without it, and
// power coming back is a power-on reset at bench time; part models built in supply order.

const PINS = ['D2', 'D3'];

/** A fake board whose power a key input turns off ('off') and on ('on'). */
function switchedBoard(): PartDefinition {
  const base = fakeBoard('switched-board', PINS);
  return {
    ...base,
    createModel() {
      const power = { on: true };
      return {
        power,
        input(event: PartInput) {
          if (event.kind === 'key' && event.down) power.on = event.key === 'on';
        },
        reset() {
          power.on = true;
        },
      };
    },
  };
}

/** D2 high from 1 µs after each reset. */
const SCRIPT: FakeStep[] = [{ cycle: 16, pin: 'D2', mode: 'output', level: 1 }];

function bench() {
  const mcu = new FakeMcu({ pins: PINS, script: SCRIPT });
  const b = new Bench(testDoc({ board: 'switched-board' }), makeBenchEnv([switchedBoard()], () => mcu));
  return { mcu, b };
}

describe('board power (BT200)', () => {
  it('an unpowered board’s MCU doesn’t run and its pins float; power back is a power-on reset at bench time', () => {
    const { mcu, b } = bench();
    b.runUntil(NS_PER_MS);
    expect(b.pinState('board', 'D2')?.level).toBe(1);
    expect(b.boardPowered('board')).toBe(true);
    const resets = mcu.resets;
    b.input('board', { kind: 'key', key: 'off', down: true });
    expect(b.boardPowered('board')).toBe(false);
    b.runUntil(2 * NS_PER_MS);
    expect(b.pinState('board', 'D2')?.level).toBeNull(); // floating
    const halted = mcu.cycles;
    b.runUntil(5 * NS_PER_MS);
    expect(mcu.cycles).toBe(halted); // no cycles without power
    expect(mcu.resets).toBe(resets);
    b.input('board', { kind: 'key', key: 'on', down: true });
    b.runUntil(5 * NS_PER_MS + 0.5 * NS_PER_MS);
    expect(mcu.resets).toBe(resets + 1); // the power-on reset
    // Its clock restarted when power came back (at the next slice, 5 ms): 0.5 ms of cycles since.
    expect(mcu.cycles).toBe(16_000 * 0.5);
    expect(b.pinState('board', 'D2')?.level).toBe(1); // the script ran again from reset
  });

  it('a board that starts unpowered never runs; a bench reset powers it up as its model says', () => {
    const { mcu, b } = bench();
    b.input('board', { kind: 'key', key: 'off', down: true });
    b.runUntil(3 * NS_PER_MS);
    expect(b.pinState('board', 'D2')?.level).toBeNull();
    b.reset();
    b.runUntil(NS_PER_MS);
    expect(b.boardPowered('board')).toBe(true);
    expect(b.pinState('board', 'D2')?.level).toBe(1);
    expect(mcu.cycles).toBe(16_000);
  });

  it('boards without `power` always run', () => {
    const mcu = new FakeMcu({ pins: PINS, script: SCRIPT });
    const b = new Bench(testDoc({ board: 'plain' }), makeBenchEnv([fakeBoard('plain', PINS)], () => mcu));
    b.runUntil(NS_PER_MS);
    expect(b.boardPowered('board')).toBe(true);
    expect(mcu.cycles).toBe(16_000);
  });

  it('builds power parts, then boards, then the rest: a module listed first still drives at its board’s rail', () => {
    const seen: number[] = [];
    // A board whose model drives its own 3.3 V rail, and records what its VIN saw when built.
    const railBoard: PartDefinition = {
      ...fakeBoard('rail-board', PINS),
      pins: [
        { name: 'D2', x: 0, y: 0, role: 'digital' },
        { name: 'D3', x: 2.54, y: 0, role: 'digital' },
        { name: '3V3', x: 0, y: 10, role: 'power' },
        { name: 'VIN', x: 5.08, y: 10, role: 'power' },
        { name: 'GND', x: 2.54, y: 10, role: 'ground', volts: 0 },
      ],
      createModel(ctx) {
        seen.push(ctx.pin('VIN').read().volts);
        ctx.pin('3V3').driveVolts(3.3, Strength.supply);
        return {};
      },
    };
    const battery: PartDefinition = {
      type: 'test-battery',
      title: 'battery',
      category: 'power',
      size: { w: 5, h: 5 },
      pins: [
        { name: '+', x: 0, y: 0, role: 'power' },
        { name: '-', x: 2.54, y: 0, role: 'ground', volts: 0 },
      ],
      defaults: {},
      createModel(ctx) {
        ctx.pin('+').driveVolts(9, Strength.supply);
        return {};
      },
    };
    const module: PartDefinition = {
      type: 'test-module',
      title: 'module',
      category: 'sensors',
      size: { w: 5, h: 5 },
      pins: [
        { name: 'VCC', x: 0, y: 0, role: 'power' },
        { name: 'OUT', x: 2.54, y: 0, role: 'digital' },
      ],
      defaults: {},
      createModel(ctx) {
        ctx.pin('OUT').drive(1, Strength.strong);
        return {};
      },
    };
    const mcu = new FakeMcu({ pins: PINS });
    // The module and the battery come before the board in the document.
    const doc = testDoc({ mod: 'test-module', bat: 'test-battery', board: 'rail-board' }, [
      ['mod:VCC', 'board:3V3'],
      ['bat:+', 'board:VIN'],
      ['bat:-', 'board:GND'],
    ]);
    const b = new Bench(doc, makeBenchEnv([railBoard, battery, module], () => mcu));
    b.runUntil(10 * NS_PER_US);
    expect(seen).toEqual([9]); // the battery was built first
    expect(b.pinState('mod', 'OUT')?.volts).toBeCloseTo(3.3, 6); // the module's 1 is its rail's 3.3 V
  });
});
