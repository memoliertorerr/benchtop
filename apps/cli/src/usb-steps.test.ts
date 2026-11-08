import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { nodeIo } from './node-io.ts';
import { type RunIo, type RunReport, runHeadless } from './run.ts';

// BT145: steps that make a board's USB host talk back — MIDI to the device's MIDI port, the host's
// lock keys to its keyboards — at exactly their time.

const io: RunIo = { readFile: (path) => readFileSync(resolve(REPO_ROOT, path)), now: () => performance.now() };
const s3io: RunIo = { ...io, esp32s3Rom: () => nodeIo.esp32s3Rom?.() };

/** An S3 board on its own (and a second board, an Uno, when `uno`), running `firmware`. */
function run(firmware: string, steps: unknown[], expect: string[], options: { uno?: boolean; duration?: string } = {}): RunReport {
  const parts: unknown[] = [{ id: 's3', type: 'esp32-s3-devkitc-1', x: 0, y: 0, rotation: 0, props: {} }];
  if (options.uno === true) parts.push({ id: 'uno', type: 'arduino-uno', x: 100, y: 0, rotation: 0, props: {} });
  return runHeadless(
    {
      project: '(inline)',
      projectJson: { format: 1, name: 'usb', parts, wires: [], firmware: {} },
      firmware: { s3: `fixtures/firmware/esp32s3/${firmware}.bin`, ...(options.uno === true ? { uno: 'fixtures/firmware/uno/blink.hex' } : {}) },
      scriptJson: { steps },
      expect,
      ...(options.duration === undefined ? {} : { duration: options.duration }),
    },
    s3io,
  );
}

describe('midi and locks steps (BT145)', () => {
  it('a midi step plays on the synth at its time; a SysEx arrives whole', () => {
    const r = run(
      'usb-synth',
      [
        { at: '600ms', midi: '90 45 64' },
        { at: '700ms', midi: '80 45 00  F0 7E 7F 06 01 F7', board: 's3' },
      ],
      ['serial contains "note on 69 100" by 650ms', 'pin s3:IO5 frequency is 440 ±1% between 620ms and 700ms', 'serial contains "sysex F0 7E 7F 06 01 F7" by 750ms', 'serial contains "note on" by 600ms'],
    );
    expect(r.error).toBeNull();
    expect(r.assertions.map((a) => [a.text, a.ok])).toEqual([
      ['serial contains "note on 69 100" by 650ms', true],
      ['pin s3:IO5 frequency is 440 ±1% between 620ms and 700ms', true],
      ['serial contains "sysex F0 7E 7F 06 01 F7" by 750ms', true],
      ['serial contains "note on" by 600ms', false], // not before its step
    ]);
  }, 60_000);

  it('a locks step reaches the keyboard as its LEDs; the next step turns them off again', () => {
    const r = run(
      'usb-locks',
      [
        { at: '600ms', locks: ['caps', 'scroll'] },
        { at: '800ms', locks: [] },
      ],
      ['serial contains "leds num 0 caps 1 scroll 1" by 650ms', 'serial contains "leds num 0 caps 0 scroll 0" by 850ms'],
    );
    expect(r.error).toBeNull();
    expect(r.assertions.map((a) => a.ok)).toEqual([true, true]);
  }, 60_000);

  it('a midi step before the device runs, or to one without MIDI, ends the run naming why', () => {
    const early = run('usb-synth', [{ at: '5ms', midi: '90 3C 64' }], [], { duration: '10ms' });
    expect(early.exitCode).toBe(2);
    expect(early.error).toBe("script step 1 (midi to s3) at 5 ms: no USB device on the board's port (the firmware hasn't started USB)");
    const keys = run('usb-locks', [{ at: '600ms', midi: '90 3C 64' }], []);
    expect(keys.exitCode).toBe(2);
    expect(keys.error).toBe('script step 1 (midi to s3) at 600 ms: USB device "ESP32S3_DEV" has no MIDI port to send to');
  }, 60_000);

  it('usage errors: the bytes, the locks, the board', () => {
    const errorOf = (step: Record<string, unknown>, uno = false): string | null => run('usb-synth', [{ at: '1ms', ...step }], [], { uno, duration: '1ms' }).error;
    expect(errorOf({ midi: '90 3C' })).toBe('script step 1: the message at byte 1 (90) needs 2 data bytes');
    expect(errorOf({ midi: 'note on' })).toBe('script step 1: "midi" is MIDI bytes in hex, e.g. "90 3C 64"');
    expect(errorOf({ midi: '' })).toBe('script step 1: "midi" is MIDI bytes in hex, e.g. "90 3C 64"');
    expect(errorOf({ locks: 'caps' })).toBe('script step 1: "locks" lists the lock keys on: "num", "caps", "scroll" ([] for none)');
    expect(errorOf({ locks: ['shift'] })).toBe('script step 1: "locks" lists the lock keys on: "num", "caps", "scroll" ([] for none)');
    expect(errorOf({ locks: [], midi: '90 3C 64' })).toBe('script step 1: give "midi" or "locks", not both');
    expect(errorOf({ locks: [], part: 's3' })).toBe('script step 1: a "locks" step names a "board", not a "part"');
    expect(errorOf({ locks: [], board: 'uno' }, true)).toBe('script step 1: "uno" has no USB port the bench hosts (an ESP32-S3 board has)');
    expect(errorOf({ locks: [], board: 'nope' })).toBe('script step 1: no board "nope"');
    expect(errorOf({ locks: ['num'] }, true)).toBeNull(); // one board with a USB host: no "board" needed
  }, 60_000);
});
