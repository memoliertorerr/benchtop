import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { parseAssertion, parseScript, type RunIo, runHeadless, UsageError } from './run.ts';

// BT55: `set` steps (channel inputs, e.g. an environment source's rate or on/off) and `env`
// expectations (the world's value at a part), on gas-meter with a room and a leak added inline.

const io: RunIo = { readFile: (path) => readFileSync(resolve(REPO_ROOT, path)), now: () => performance.now() };

function gasRoom(): unknown {
  const doc = JSON.parse(readFileSync(resolve(REPO_ROOT, 'fixtures/projects/gas-meter.json'), 'utf8')) as { parts: unknown[] };
  doc.parts.push(
    { id: 'room', type: 'environment', x: -150, y: 120, rotation: 0, props: { ventilation: 0 } },
    { id: 'leak', type: 'gas-leak', x: 79.1, y: 1.3, rotation: 0, props: { rate: 5, on: false } },
  );
  return doc;
}

describe('set steps', () => {
  it('expand into channel inputs in key order, booleans as 1/0', () => {
    const doc = gasRoom() as Parameters<typeof parseScript>[1];
    const { steps } = parseScript([{ at: '1s', part: 'leak', set: { rate: 8, on: true } }], doc, ['uno']);
    expect(steps).toEqual([
      { kind: 'input', at: 1e9, part: 'leak', input: { kind: 'key', key: 'set:rate=8', down: true } },
      { kind: 'input', at: 1e9, part: 'leak', input: { kind: 'key', key: 'set:on=1', down: true } },
    ]);
  });

  it('refuse bad channels, values and mixing with input', () => {
    const doc = gasRoom() as Parameters<typeof parseScript>[1];
    const bad = (step: unknown): string => {
      try {
        parseScript([step], doc, ['uno']);
      } catch (error) {
        if (error instanceof UsageError) return error.message;
      }
      return 'no error';
    };
    expect(bad({ at: '1s', part: 'leak', set: { 'bad name': 1 } })).toMatch(/not a channel name/);
    expect(bad({ at: '1s', part: 'leak', set: { rate: 'x' } })).toMatch(/finite number or a boolean/);
    expect(bad({ at: '1s', part: 'leak', set: {} })).toMatch(/names no channel/);
    expect(bad({ at: '1s', part: 'leak', set: { on: true }, input: { kind: 'press' } })).toMatch(/not both/);
  });
});

describe('env expectations', () => {
  it('parse every form', () => {
    expect(parseAssertion('env gas at mq is 400 ±50 at 2s')).toMatchObject({ kind: 'env', field: 'gas', part: 'mq', op: 'is', value: 400, tolerance: 50, at: 2e9 });
    expect(parseAssertion('env temperature at t1 > 25.5 at 500ms')).toMatchObject({ field: 'temperature', op: '>', value: 25.5 });
    expect(parseAssertion('env sound at s <= 60 at 1s')).toMatchObject({ field: 'sound', op: '<=', value: 60 });
    expect(parseAssertion('env humidity at d is -1 +- 2 at 1s')).toMatchObject({ value: -1, tolerance: 2 });
    expect(() => parseAssertion('env wind at x is 1 ±1 at 1s')).toThrow(UsageError);
  });

  it('a leak switched on by a step reaches the sensor; the alarm and the world agree', () => {
    const r = runHeadless(
      {
        project: 'gas-room (inline)',
        projectJson: gasRoom(),
        firmware: { uno: 'fixtures/firmware/uno/gas-meter.hex' },
        scriptJson: [{ at: '300ms', part: 'leak', set: { on: true } }],
        expect: ['env gas at gas < 1 at 250ms', 'env gas at gas > 500 at 4s', 'serial contains "alarm=1" by 4s', 'env gas at gas is 0 ±1 at 4s'],
      },
      io,
    );
    expect(r.error).toBeNull();
    expect(r.assertions.map((a) => a.ok)).toEqual([true, true, true, false]);
    expect(r.assertions[3].detail).toMatch(/^gas \d+\.\d\d ppm$/);
  });

  it('are usage errors without a room, or on a part not placed in it', () => {
    const plain = runHeadless({ project: 'fixtures/projects/gas-meter.json', firmware: { uno: 'fixtures/firmware/uno/gas-meter.hex' }, expect: ['env gas at gas > 1 at 1s'] }, io);
    expect(plain.exitCode).toBe(2);
    expect(plain.error).toMatch(/no environment part/);
    const board = runHeadless({ project: 'x', projectJson: gasRoom(), firmware: { uno: 'fixtures/firmware/uno/gas-meter.hex' }, expect: ['env gas at uno > 1 at 1s'] }, io);
    expect(board.error).toMatch(/not a part placed in the environment/);
  });
});
