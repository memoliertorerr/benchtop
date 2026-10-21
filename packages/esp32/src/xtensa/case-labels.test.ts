import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OP } from './isa.ts';
import { SR, UR } from './regs.ts';

// BT37: the hot switches (XtensaCore.execute, readSpecial/writeSpecial, executeFpu) label their
// cases with number literals — V8 compiles a switch on literals to a jump table, but one on
// `OP.ADD`-style properties (or module consts) to a chain of compares, measured 53 vs 14 ns a
// dispatch over 200 cases. Each literal carries its name, `case 2 /* OP.ADD */:`; this test
// keeps them equal to the tables.

const TABLES: Record<string, Record<string, number>> = { OP, SR, UR };

describe('literal case labels', () => {
  for (const file of ['cpu.ts', 'ops/fpu.ts']) {
    it(`${file}: every "case N /* T.NAME */" is T.NAME, and no case uses a table property`, () => {
      const source = readFileSync(join(import.meta.dirname, file), 'utf8');
      const labels = [...source.matchAll(/case (\d+) \/\* (OP|SR|UR)\.([A-Z0-9_]+) \*\/:/g)];
      expect(labels.length).toBeGreaterThan(40);
      for (const [, n, table, name] of labels) expect(`${table}.${name} = ${n}`).toBe(`${table}.${name} = ${TABLES[table][name]}`);
      expect(source.match(/case (OP|SR|UR)\.[A-Z0-9_]+:/g)).toBeNull();
    });
  }
});
