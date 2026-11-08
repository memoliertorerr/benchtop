import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { nodeIo } from './node-io.ts';
import { MAX_FILE_STEP, type RunIo, type RunReport, runHeadless } from './run.ts';

// BT144: script and spec steps that write and remove files on a part's storage — a microSD card,
// an ESP32-S3 board's USB drive — at exactly their time, and the errors when one can't apply.

const io: RunIo = { readFile: (path) => readFileSync(resolve(REPO_ROOT, path)), now: () => performance.now() };
const s3io: RunIo = { ...io, esp32s3Rom: () => nodeIo.esp32s3Rom?.() };

function card(steps: unknown[], expect: string[] = [], duration = '1s'): RunReport {
  return runHeadless({ project: 'fixtures/projects/sd-log.json', firmware: { uno: 'fixtures/firmware/uno/sd-log.hex' }, scriptJson: { steps }, expect, duration }, io);
}

function drive(steps: unknown[], expect: string[] = [], duration = '2s'): RunReport {
  return runHeadless({ project: 'fixtures/projects/esp32s3-usb-drive.json', firmware: { s3: 'fixtures/firmware/esp32s3/usb-drive.bin' }, scriptJson: { steps }, expect, duration }, s3io);
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

describe('file steps on a microSD card (BT144)', () => {
  it('a write at 0 ms is what the sketch reads at startup; a remove takes the file away', () => {
    const written = card([{ at: '0ms', part: 'sd', write: 'CONFIG.TXT', text: 'rate=99\n' }], ['serial contains "config: rate=99" by 1s', 'file sd CONFIG.TXT contains "rate=99" by 1ms']);
    expect(written.error).toBeNull();
    expect(written.assertions.map((a) => a.ok)).toEqual([true, true]);
    expect(written.serial.uno).not.toContain('rate=10');

    const removed = card([{ at: '0ms', part: 'sd', remove: 'config.txt' }], ['serial contains "done" by 1s']);
    expect(removed.error).toBeNull();
    expect(removed.assertions[0].ok).toBe(true);
    expect(removed.serial.uno).not.toContain('config:');
  }, 30_000);

  it('steps apply in file order at their time: a new CONFIG.TXT and a reset print it on the next boot', () => {
    const r = card(
      [
        { at: '600ms', part: 'sd', write: 'CONFIG.TXT', text: 'rate=7\n' },
        { at: '600ms', reset: 'uno' },
        { at: '600ms', part: 'sd', write: 'data/b.bin', base64: b64('binary ok') },
      ],
      ['serial contains "config: rate=7" by 1.5s', 'file sd DATA/B.BIN contains "binary ok" by 600ms'],
      '1.5s',
    );
    expect(r.error).toBeNull();
    expect(r.assertions.map((a) => [a.ok, a.atNs])).toEqual([
      [true, expect.any(Number)],
      [true, 600e6],
    ]);
    expect(r.assertions[0].atNs).toBeGreaterThan(600e6);
    expect(r.serial.uno.indexOf('config: rate=10')).toBeLessThan(r.serial.uno.indexOf('config: rate=7'));
  }, 30_000);

  it('a step that can\'t apply ends the run, naming the step and why', () => {
    const nothing = card([{ at: '100ms', part: 'sd', remove: 'NOPE.TXT' }]);
    expect(nothing.exitCode).toBe(2);
    expect(nothing.error).toBe('script step 1 (remove NOPE.TXT on sd) at 100 ms: nothing there to remove');
    const bad = card([{ at: '100ms', part: 'sd', write: 'A:B?.TXT', text: 'x' }]);
    expect(bad.exitCode).toBe(2);
    expect(bad.error).toMatch(/^script step 1 \(write A:B\?\.TXT on sd\) at 100 ms: it couldn't be written \(/);
  }, 30_000);

  it('usage errors: the part, the path, text or base64, the size', () => {
    const errorOf = (step: Record<string, unknown>): string | null => card([{ at: '0ms', ...step }]).error;
    expect(errorOf({ part: 'uno', write: 'A.TXT', text: 'x' })).toBe('script step 1: "uno" is a arduino-uno, not a part that keeps files (a microSD card, or an ESP32-S3 board\'s USB drive)');
    expect(errorOf({ part: 'sd', write: 'A.TXT' })).toBe('script step 1: a "write" step needs "text" or "base64" (one of them)');
    expect(errorOf({ part: 'sd', write: 'A.TXT', text: 'x', base64: 'eA==' })).toBe('script step 1: a "write" step needs "text" or "base64" (one of them)');
    expect(errorOf({ part: 'sd', write: 'A.TXT', base64: 'not base64!' })).toBe('script step 1: "base64" is not base64');
    expect(errorOf({ part: 'sd', write: '', text: 'x' })).toBe('script step 1: "write" must be a file\'s path (up to 1024 characters)');
    expect(errorOf({ part: 'sd', remove: 'A.TXT', text: 'x' })).toBe('script step 1: a "remove" step takes no "text" or "base64"');
    expect(errorOf({ part: 'sd', write: 'A.TXT', remove: 'B.TXT', text: 'x' })).toBe('script step 1: give one of "input", "set", "write" or "remove"');
    expect(errorOf({ part: 'sd', write: 'A.TXT', text: 'x', input: { kind: 'press' } })).toBe('script step 1: give one of "input", "set", "write" or "remove"');
    expect(errorOf({ part: 'sd', write: 'A.TXT', text: 'x'.repeat(MAX_FILE_STEP + 1) })).toBe(`script step 1: a "write" step holds at most ${MAX_FILE_STEP} bytes; this one has ${MAX_FILE_STEP + 1}`);
    expect(errorOf({ part: 'sd', write: 'A.TXT', text: 'x'.repeat(MAX_FILE_STEP) })).toBeNull();
  }, 30_000);
});

describe('file steps on an ESP32-S3 board\'s USB drive (BT144)', () => {
  it('a CONFIG.TXT written once the drive is mounted reaches the sketch; one before it is an error', () => {
    const r = drive([{ at: '1s', part: 's3', write: 'CONFIG.TXT', text: 'led=blue\n' }], ['serial contains "config led=blue" by 1.5s', 'serial contains "led blue" by 1.5s', 'file s3 CONFIG.TXT contains "led=blue" by 1s']);
    expect(r.error).toBeNull();
    expect(r.assertions.map((a) => [a.text, a.ok])).toEqual([
      ['serial contains "config led=blue" by 1.5s', true],
      ['serial contains "led blue" by 1.5s', true],
      ['file s3 CONFIG.TXT contains "led=blue" by 1s', true],
    ]);

    const early = drive([{ at: '5ms', part: 's3', write: 'CONFIG.TXT', text: 'led=red\n' }], [], '10ms');
    expect(early.exitCode).toBe(2);
    expect(early.error).toBe('script step 1 (write CONFIG.TXT on s3) at 5 ms: "s3" keeps no files then (no USB drive mounted yet)');

    const removed = drive(
      [
        { at: '1s', part: 's3', remove: 'README.TXT' },
        { at: '1.2s', part: 's3', remove: 'README.TXT' },
      ],
      [],
    );
    expect(removed.exitCode).toBe(2);
    expect(removed.error).toBe('script step 2 (remove README.TXT on s3) at 1.2 s: nothing there to remove');
  }, 60_000);
});
