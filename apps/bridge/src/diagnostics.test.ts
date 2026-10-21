import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDiagnostics } from './diagnostics.ts';

// A failed compile's `arduino-cli compile --json` output (1.5.1), paths sanitized.
const sample = JSON.parse(readFileSync(new URL('./__fixtures__/compile-error.json', import.meta.url), 'utf8')) as unknown;

describe('compiler diagnostics', () => {
  it('parses arduino-cli JSON into file, line, column, severity and message', () => {
    expect(parseDiagnostics(sample)).toEqual([
      { file: '/Users/maker/Arduino/broken/broken.ino', line: 3, column: 1, severity: 'error', message: "expected ';' before '}' token" },
      { file: '/Users/maker/Arduino/broken/broken.ino', line: 6, column: 20, severity: 'error', message: "'HIGHER' was not declared in this scope" },
      { file: '/Users/maker/Arduino/broken/broken.ino', line: 7, column: 7, severity: 'warning', message: "unused variable 'unused' [-Wunused-variable]" },
    ]);
  });

  it('returns nothing for output without diagnostics', () => {
    expect(parseDiagnostics(null)).toEqual([]);
    expect(parseDiagnostics({ success: true, builder_result: {} })).toEqual([]);
    expect(parseDiagnostics({ builder_result: { diagnostics: 'nope' } })).toEqual([]);
  });

  it('defaults missing fields instead of trusting them', () => {
    expect(parseDiagnostics({ builder_result: { diagnostics: [{ severity: 'NOTE', line: 'x', message: 'a\nb' }, null] } })).toEqual([
      { file: '', line: 0, column: 0, severity: 'info', message: 'a' },
      { file: '', line: 0, column: 0, severity: 'info', message: '' },
    ]);
  });
});
