import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OP } from './isa.ts';

// As in the Xtensa core (BT37): the interpreter's switch labels its cases with number literals,
// which V8 compiles to a jump table. Each literal carries its name, `case 28 /* OP.ADD */:`;
// this test keeps them equal to the table and covers every op.

describe('literal case labels', () => {
  it('cpu.ts: every "case N /* OP.NAME */" is OP.NAME, every op has one, and no case uses a property', () => {
    const source = readFileSync(join(import.meta.dirname, 'cpu.ts'), 'utf8');
    const labels = [...source.matchAll(/case (\d+) \/\* OP\.([A-Z0-9_]+) \*\/:/g)];
    const table = OP as Record<string, number>;
    for (const [, n, name] of labels) expect(`OP.${name} = ${n}`).toBe(`OP.${name} = ${table[name]}`);
    const covered = new Set(labels.map(([, , name]) => name));
    // INVALID, SRET and DRET reach the default case (illegal instruction).
    const missing = Object.keys(OP).filter((name) => !covered.has(name) && !['INVALID', 'SRET', 'DRET'].includes(name));
    expect(missing).toEqual([]);
    expect(source.match(/case OP\.[A-Z0-9_]+:/g)).toBeNull();
    expect(source.match(/^\s*case \d+:/gm)).toBeNull();
  });
});
