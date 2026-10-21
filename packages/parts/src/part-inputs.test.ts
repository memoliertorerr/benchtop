import { Bench, type PartInput, parseProject } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { benchEnvParts, CATALOG } from './catalog.ts';
import { PART_INPUTS, type PartInputSpec, partInputs } from './part-inputs.ts';

const mid = (min = 0, max = 1): number => (min + max) / 2;

/** Events that exercise one listed input. */
function eventsFor(spec: PartInputSpec): PartInput[] {
  switch (spec.kind) {
    case 'press':
    case 'release':
      return [{ kind: spec.kind }];
    case 'value':
      return [{ kind: 'value', value: mid(spec.min, spec.max) }];
    case 'channel':
      return [{ kind: 'key', key: `set:${spec.channel}=${mid(spec.min, spec.max)}`, down: true }];
    case 'key': {
      const key = spec.keys[0] === 'ir:<code>' ? 'ir:162' : spec.keys[0];
      return [{ kind: 'key', key, down: true }, { kind: 'key', key, down: false }];
    }
  }
}

// BT68: the input table names catalog parts only, and every input it lists reaches a model that
// takes it without throwing (a bench with one of each listed part, unwired).

describe('PART_INPUTS', () => {
  it('names catalog parts, each with well-formed inputs', () => {
    for (const [type, inputs] of Object.entries(PART_INPUTS)) {
      expect(CATALOG.get(type), type).toBeDefined();
      expect(inputs.length, type).toBeGreaterThan(0);
      for (const input of inputs) {
        expect(input.does.length, type).toBeGreaterThan(3);
        if (input.kind === 'key') expect(input.keys.length, type).toBeGreaterThan(0);
        if ((input.kind === 'value' || input.kind === 'channel') && input.min !== undefined && input.max !== undefined) expect(input.min, type).toBeLessThan(input.max);
      }
    }
    expect(partInputs('resistor')).toEqual([]);
  });

  it('every listed input is accepted by the part on a bench', () => {
    const types = Object.keys(PART_INPUTS);
    const parsed = parseProject({ format: 1, name: 'inputs', parts: types.map((type, i) => ({ id: `p${i}`, type, x: 0, y: i * 60, rotation: 0, props: {} })), wires: [], firmware: {} });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors.slice(0, 3)));
    const bench = new Bench(parsed.doc, { part: benchEnvParts, createMcu: () => undefined });
    bench.reset();
    types.forEach((type, i) => {
      for (const spec of PART_INPUTS[type]) {
        const events = eventsFor(spec);
        for (const event of events) expect(() => bench.input(`p${i}`, event), `${type} ${JSON.stringify(event)}`).not.toThrow();
      }
    });
    bench.runFor(10_000_000);
    bench.dispose();
  });
});
