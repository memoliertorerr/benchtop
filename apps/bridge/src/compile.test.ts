import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIntelHex } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { arduinoCliCandidates, compile, findArduinoCli } from './compile.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('compile with the local arduino-cli', () => {
  // The tests that run the real compiler: arduino-cli and the AVR core are prerequisites
  // (see fixtures/README.md), so a missing tool fails here rather than skipping. BT45: the Nano
  // compiles with its own FQBN (the same chip, another variant: A6/A7).
  for (const [board, fqbn] of [
    ['uno', 'arduino:avr:uno'],
    ['nano', 'arduino:avr:nano'],
  ] as const) {
    it(
      `compiles fixtures/sketches/${board}/blink with ${fqbn} to the committed blink.hex`,
      async () => {
        const cli = findArduinoCli();
        expect(cli, `arduino-cli not found in ${arduinoCliCandidates().join(', ')}`).toBeDefined();
        const result = await compile(cli as string, join(ROOT, 'fixtures', 'sketches', board, 'blink'), fqbn);
        console.info(`bridge compile of ${board}/blink: ${result.durationMs} ms`);
        expect(result.error).toBeUndefined();
        expect(result.ok).toBe(true);
        expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        const committed = parseIntelHex(readFileSync(join(ROOT, 'fixtures', 'firmware', board, 'blink.hex'), 'utf8'), { maxBytes: 32 * 1024 });
        const built = parseIntelHex(result.artifacts.hex ?? '', { maxBytes: 32 * 1024 });
        expect(built.used).toEqual(committed.used);
        expect(Buffer.from(built.bytes).equals(Buffer.from(committed.bytes))).toBe(true);
        expect(result.artifacts.elf?.subarray(0, 4)).toEqual(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
      },
      60_000,
    );
  }
});
