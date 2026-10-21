import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BridgeDiagnostic } from './bridge-client.ts';
import { compileProblemRows, rememberFolder } from './compile-problems.ts';

// The bridge's committed sample of a failed compile, after its diagnostics parser: the same
// shape the app receives.
const sample = JSON.parse(readFileSync(new URL('../../../bridge/src/__fixtures__/compile-error.json', import.meta.url), 'utf8')) as {
  builder_result: { diagnostics: { severity: string; file: string; line: number; column: number; message: string }[] };
};
const diagnostics: BridgeDiagnostic[] = sample.builder_result.diagnostics.map((d) => ({
  file: d.file,
  line: d.line,
  column: d.column,
  severity: d.severity.toLowerCase() as BridgeDiagnostic['severity'],
  message: d.message.split('\n')[0]!,
}));

describe('compile diagnostics → Problems rows', () => {
  it('shows file:line:col relative to the sketch folder and copies the full file:line', () => {
    const rows = compileProblemRows('uno', '/Users/maker/Arduino/broken', { ok: false, diagnostics, error: 'Error during build: exit status 1' });
    expect(rows.map(({ severity, location, copy, message }) => ({ severity, location, copy, message }))).toEqual([
      { severity: 'error', location: 'broken.ino:3:1', copy: '/Users/maker/Arduino/broken/broken.ino:3', message: "expected ';' before '}' token" },
      { severity: 'error', location: 'broken.ino:6:20', copy: '/Users/maker/Arduino/broken/broken.ino:6', message: "'HIGHER' was not declared in this scope" },
      { severity: 'warning', location: 'broken.ino:7:7', copy: '/Users/maker/Arduino/broken/broken.ino:7', message: "unused variable 'unused' [-Wunused-variable]" },
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
    expect(rows.every((r) => r.board === 'uno')).toBe(true);
  });

  it('keeps subfolders and shortens files outside the sketch to their name', () => {
    const rows = compileProblemRows('uno', '/s/blink/', {
      ok: true,
      diagnostics: [
        { file: '/s/blink/src/util.cpp', line: 2, column: 5, severity: 'warning', message: 'w' },
        { file: '/opt/arduino/libraries/Servo/Servo.cpp', line: 9, column: 1, severity: 'warning', message: 'x' },
      ],
    });
    expect(rows.map((r) => r.location)).toEqual(['src/util.cpp:2:5', 'Servo.cpp:9:1']);
    expect(rows[1]!.copy).toBe('/opt/arduino/libraries/Servo/Servo.cpp:9');
  });

  it('adds the failure itself when no diagnostic is an error (timeout, missing core)', () => {
    expect(compileProblemRows('esp', '/s/x', { ok: false, diagnostics: [], error: 'compile timed out after 120 s' })).toEqual([
      { key: 'esp:failed', board: 'esp', severity: 'error', location: '', copy: '', message: 'compile timed out after 120 s' },
    ]);
    expect(compileProblemRows('uno', '/s/x', { ok: true, diagnostics: [] })).toEqual([]);
  });
});

describe('recent sketch folders', () => {
  it('keeps five, newest first, without duplicates', () => {
    let list: string[] = [];
    for (const p of ['/a', '/b', '/c', '/d', '/e', '/f']) list = rememberFolder(list, p);
    expect(list).toEqual(['/f', '/e', '/d', '/c', '/b']);
    expect(rememberFolder(list, '/c')).toEqual(['/c', '/f', '/e', '/d', '/b']);
  });
});
