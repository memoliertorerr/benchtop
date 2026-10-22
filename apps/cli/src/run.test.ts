import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { cachedMicroPython } from '../../../packages/rp2040/src/micropython.test-helper.ts';
import { parseAssertion, parseRunArgs, parseTime, type RunIo, type RunOptions, type RunReport, runHeadless, UsageError } from './run.ts';

// The headless runner in-process (BT25): files come from the repo, plus virtual ones.

function io(virtual: Record<string, string> = {}): RunIo {
  return {
    readFile(path) {
      if (path in virtual) return new TextEncoder().encode(virtual[path]);
      return readFileSync(resolve(REPO_ROOT, path));
    },
    now: () => performance.now(),
  };
}

const PROJECT = 'fixtures/projects/cli-demo.json';
const FIRMWARE = { uno: 'fixtures/firmware/uno/cli-demo.hex' };
const PRESS = JSON.stringify([
  { at: '100ms', part: 'btn1', input: { kind: 'press' } },
  { at: '300ms', part: 'btn1', input: { kind: 'release' } },
]);
const run = (options: Partial<RunOptions>, virtual: Record<string, string> = {}): RunReport =>
  runHeadless({ project: PROJECT, firmware: FIRMWARE, expect: [], ...options }, io(virtual));

describe('runHeadless', () => {
  it('passes pin, serial and scripted-input assertions → exit 0', () => {
    const report = run(
      {
        script: 'press.json',
        expect: ['pin uno:13 is 0 at 500ms', 'pin uno:13 is 1 at 1500ms', 'serial contains "boot" by 100ms', 'serial contains "pressed" by 2s'],
      },
      { 'press.json': PRESS },
    );
    expect(report.error).toBeNull();
    expect(report.assertions.map((a) => [a.text, a.ok, a.detail])).toEqual([
      ['pin uno:13 is 0 at 500ms', true, 'level 0'],
      ['pin uno:13 is 1 at 1500ms', true, 'level 1'],
      ['serial contains "boot" by 100ms', true, expect.stringMatching(/^seen at /)],
      ['serial contains "pressed" by 2s', true, expect.stringMatching(/^seen at /)],
    ]);
    // "pressed" comes right after the press at 100 ms.
    const pressed = report.assertions[3].atNs!;
    expect(pressed).toBeGreaterThan(100e6);
    expect(pressed).toBeLessThan(110e6);
    expect(report).toMatchObject({ ok: true, exitCode: 0, simulatedNs: 2e9, problems: [] });
    expect(report.serial.uno).toBe('boot\r\npressed\r\n');
    expect(report.simulatedMHz).toBeGreaterThan(0);
  });

  it('a failing assertion → exit 1 with the level it saw', () => {
    const report = run({ expect: ['pin uno:13 is 1 at 500ms', 'serial contains "pressed" by 1s'] });
    expect(report).toMatchObject({ ok: false, exitCode: 1, error: null });
    expect(report.assertions).toEqual([
      { text: 'pin uno:13 is 1 at 500ms', ok: false, atNs: 500e6, detail: 'level 0' },
      { text: 'serial contains "pressed" by 1s', ok: false, atNs: null, detail: 'not seen by 1 s' },
    ]);
  });

  it('usage and load errors → exit 2 with a message', () => {
    const cases: [Partial<RunOptions>, Record<string, string>, RegExp][] = [
      [{ firmware: { uno: 'fixtures/firmware/uno/nope.hex' }, duration: '1s' }, {}, /cannot read firmware/],
      [{ project: 'bad.json', duration: '1s' }, { 'bad.json': '{"format":1,"parts":"x"}' }, /invalid project/],
      [{ project: 'bad.json', duration: '1s' }, { 'bad.json': 'not json' }, /not JSON/],
      [{ script: 's.json' }, { 's.json': '[{"at":"100ms","part":"btn9","input":{"kind":"press"}}]' }, /no part "btn9"/],
      [{ expect: ['pin uno:13 is 1 at 100'] }, {}, /needs a unit/],
      [{ duration: '100' }, {}, /needs a unit/],
      [{}, {}, /nothing sets the run length/],
      [{ duration: '1s', expect: ['pin uno:13 is 1 at 1500ms'] }, {}, /past the run/],
      [{ expect: ['pin uno:99 is 1 at 1s'] }, {}, /no pin "99"/],
      [{ expect: ['serial[mega] contains "x" by 1s'] }, {}, /no board "mega"/],
      [{ expect: ['led uno:13 is on'] }, {}, /not an assertion/],
      [{ firmware: { uno: 'fixtures/projects/cli-demo.json' }, duration: '1s' }, {}, /\.hex, \.elf, \.bin, \.uf2 or a MicroPython \.py/],
    ];
    for (const [options, virtual, message] of cases) {
      const report = run(options, virtual);
      expect(report.exitCode, String(message)).toBe(2);
      expect(report.error, String(message)).toMatch(message);
      expect(report.ok).toBe(false);
    }
    // A sketch reference with no --firmware can't run: the CLI doesn't compile.
    const project = JSON.parse(readFileSync(resolve(REPO_ROOT, PROJECT), 'utf8')) as { firmware: unknown };
    project.firmware = { uno: { kind: 'sketch', path: '/tmp/x', fqbn: 'arduino:avr:uno' } };
    const sketch = runHeadless({ project: 'p.json', firmware: {}, expect: [], duration: '1s' }, io({ 'p.json': JSON.stringify(project) }));
    expect(sketch).toMatchObject({ exitCode: 2, error: expect.stringMatching(/names sketch/) });
  });

  it('two runs with the same inputs give the same report apart from wallMs and simulatedMHz', () => {
    const options = { script: 'press.json', expect: ['serial contains "pressed" by 1s', 'pin uno:2 is 1 at 400ms'] };
    const strip = (r: RunReport) => ({ ...r, wallMs: 0, simulatedMHz: 0 });
    expect(strip(run(options, { 'press.json': PRESS }))).toEqual(strip(run(options, { 'press.json': PRESS })));
  });

  it('D13 and 13 name the same board pin; a script can carry its own assertions', () => {
    const script = JSON.stringify({ steps: [], expect: ['pin uno:D13 is 1 at 1100ms', 'pin btn1:1.l is 1 at 50ms'] });
    const report = run({ script: 's.json' }, { 's.json': script });
    expect(report.assertions.map((a) => a.ok)).toEqual([true, true]);
    expect(report.simulatedNs).toBe(1100e6);
  });
});

describe('serial steps (BT48)', () => {
  it('a serial step types text into a board at its time: serial-echo sends it back', () => {
    const report = runHeadless(
      { project: 'fixtures/projects/debug-demo.json', firmware: { uno: 'fixtures/firmware/uno/serial-echo.hex' }, expect: ['serial contains "abc" by 150ms'], scriptJson: [{ at: '100ms', serial: 'abc' }] },
      io(),
    );
    expect(report.error).toBeNull();
    expect(report.assertions[0]).toMatchObject({ ok: true });
    // Sent at 100 ms: nothing echoes before it.
    expect(report.assertions[0].atNs).toBeGreaterThan(100e6);
    const early = runHeadless(
      { project: 'fixtures/projects/debug-demo.json', firmware: { uno: 'fixtures/firmware/uno/serial-echo.hex' }, expect: ['serial contains "abc" by 90ms'], scriptJson: [{ at: '100ms', serial: 'abc' }] },
      io(),
    );
    expect(early.exitCode).toBe(1);
  });

  it('runs MicroPython: a .py as --firmware, an inline MicroPython sketch with none, the REPL typed into (BT63)', () => {
    const withPython = (virtual: Record<string, string> = {}): RunIo => ({ ...io(virtual), micropython: () => cachedMicroPython() });
    const file = runHeadless(
      { project: 'fixtures/projects/pico-blink.json', firmware: { pico: 'fixtures/micropython/hello/main.py' }, expect: ['serial contains "ValueError: boom" by 500ms', 'serial contains "42" by 900ms'], scriptJson: [{ at: '600ms', serial: 'print(6 * 7)\r' }] },
      withPython(),
    );
    expect(file.error).toBeNull();
    expect(file.assertions.map((a) => a.ok)).toEqual([true, true]);
    const project = JSON.parse(readFileSync(resolve(REPO_ROOT, 'fixtures/projects/pico-blink.json'), 'utf8')) as { firmware: Record<string, unknown> };
    project.firmware.pico = { kind: 'inline', fqbn: 'micropython:rp2:pico', files: { 'main.py': 'print("inline")\n' }, main: 'main.py' };
    const inline = runHeadless({ project: 'inline.json', firmware: {}, expect: ['serial contains "inline" by 500ms'] }, withPython({ 'inline.json': JSON.stringify(project) }));
    expect(inline.error).toBeNull();
    expect(inline.exitCode).toBe(0);
    // Without the cached interpreter: the board reports what to fetch.
    const missing = runHeadless({ project: 'fixtures/projects/pico-blink.json', firmware: { pico: 'fixtures/micropython/hello/main.py' }, expect: ['serial contains "hello" by 300ms'] }, io());
    expect(missing.exitCode).toBe(1);
    expect(JSON.stringify(missing.problems)).toMatch(/npm run fetch:micropython/);
  });

  it('refuses a serial step with no board in a two-board project, an unknown board or a non-string', () => {
    const twoBoards = { project: 'fixtures/projects/uart-chat.json', firmware: { uno: 'fixtures/firmware/uno/uart-chat.hex', esp: 'fixtures/firmware/esp32/uart-chat.bin' }, expect: [], duration: '10ms' };
    const cases: [unknown, RegExp][] = [
      [[{ at: '1ms', serial: 'x' }], /the project has 2 boards; say "board"/],
      [[{ at: '1ms', serial: 'x', board: 'mega' }], /no board "mega"/],
      [[{ at: '1ms', serial: 7, board: 'uno' }], /"serial" must be a string/],
      [[{ at: '1ms', serial: 'x'.repeat(64 * 1024 + 1), board: 'uno' }], /longer than 65536/],
    ];
    for (const [steps, message] of cases) expect(runHeadless({ ...twoBoards, scriptJson: steps }, io()).error, String(message)).toMatch(message);
  });
});

describe('grammar', () => {
  it('times need a unit', () => {
    expect([parseTime('500ms'), parseTime('2s'), parseTime('1.5us'), parseTime('40ns')]).toEqual([500e6, 2e9, 1500, 40]);
    expect(() => parseTime('100')).toThrow(UsageError);
    expect(() => parseTime('1m')).toThrow(/not a time/);
  });

  it('assertions, with escapes and a board name', () => {
    expect(parseAssertion('serial contains "a \\"b\\" \\\\ c\\n" by 1s')).toMatchObject({ kind: 'serial', needle: 'a "b" \\ c\n', board: null, by: 1e9 });
    expect(parseAssertion('serial[uno] contains "x" by 2ms')).toMatchObject({ board: 'uno', by: 2e6 });
    expect(parseAssertion('pin uno:A0 is z at 3s')).toMatchObject({ kind: 'pin', part: 'uno', pin: 'A0', level: 'z', at: 3e9 });
    expect(() => parseAssertion('serial contains "\\t" by 1s')).toThrow(/unknown escape/);
  });

  it('bus assertions (BT88): forms, usage errors, a pass and a failure on real I2C and SPI', () => {
    expect(parseAssertion('bus i2c lcd1 wrote 3c 08 by 200ms')).toMatchObject({ kind: 'bus', bus: 'i2c', part: 'lcd1', how: 'wrote', bytes: [0x3c, 0x08], by: 200e6 });
    expect(parseAssertion('bus spi tft sent 2A by 1s')).toMatchObject({ bus: 'spi', how: 'sent', bytes: [0x2a] });
    expect(() => parseAssertion('bus i2c lcd1 sent 3c by 1s')).toThrow(/"wrote" or "read"/);
    expect(() => parseAssertion('bus spi tft wrote 2a by 1s')).toThrow(/"sent"/);
    expect(() => parseAssertion('bus i2c lcd1 wrote 3 by 1s')).toThrow(/not an assertion/);
    const lcd = runHeadless(
      { project: 'fixtures/projects/lcd-i2c.json', firmware: { uno: 'fixtures/firmware/uno/lcd-i2c.hex' }, expect: ['bus i2c lcd1 wrote 3c by 200ms', 'bus i2c lcd1 read 3c by 200ms'], duration: '250ms' },
      io(),
    );
    expect(lcd.exitCode).toBe(1);
    expect(lcd.assertions.map((a) => [a.ok, a.detail.replace(/[\d.]+ (ms|us|ns|s)/, 'T')])).toEqual([
      [true, 'seen at T'],
      [false, 'not seen by T'],
    ]);
    const tft = runHeadless({ project: 'fixtures/projects/tft-demo.json', firmware: { uno: 'fixtures/firmware/uno/tft-demo.hex' }, expect: ['bus spi tft sent 2a by 500ms'], duration: '500ms' }, io());
    expect(tft.exitCode).toBe(0);
    const nobody = runHeadless({ project: 'fixtures/projects/lcd-i2c.json', firmware: { uno: 'fixtures/firmware/uno/lcd-i2c.hex' }, expect: ['bus i2c nobody wrote 00 by 1ms'] }, io());
    expect(nobody.exitCode).toBe(2);
    expect(nobody.error).toMatch(/no part "nobody"/);
  }, 30_000);

  it('file assertions (BT91): the form, usage errors, a pass and the failures on a microSD card', () => {
    expect(parseAssertion('file sd LOG.TXT contains "line 2\\n" by 1s')).toMatchObject({ kind: 'file', part: 'sd', path: 'LOG.TXT', needle: 'line 2\n', by: 1e9 });
    const card = runHeadless(
      {
        project: 'fixtures/projects/sd-log.json',
        firmware: { uno: 'fixtures/firmware/uno/sd-log.hex' },
        expect: ['file sd log.txt contains "line 2" by 1s', 'file sd DATA/A.CSV contains "0,512" by 1s', 'file sd LOG.TXT contains "line 3" by 1s', 'file sd MISSING.TXT contains "x" by 1s', 'file sd LOG.TXT contains "line 0" by 1ms'],
        duration: '1s',
      },
      io(),
    );
    expect(card.exitCode).toBe(1);
    expect(card.assertions.map((a) => [a.ok, a.detail.replace(/[\d.]+ (ms|µs|ns|s)/g, 'T')])).toEqual([
      [true, 'seen at T'],
      [true, 'seen at T'],
      [false, "not seen by T: LOG.TXT (24 bytes) doesn't hold it"],
      [false, 'not seen by T: no file MISSING.TXT'],
      [false, 'seen at T, after T'],
    ]);
    const notCard = runHeadless({ project: 'fixtures/projects/sd-log.json', firmware: { uno: 'fixtures/firmware/uno/sd-log.hex' }, expect: ['file uno LOG.TXT contains "x" by 1s'] }, io());
    expect(notCard.exitCode).toBe(2);
    expect(notCard.error).toMatch(/not a part that keeps files/);
  }, 30_000);

  it('run arguments', () => {
    expect(parseRunArgs(['p.json', '--firmware', 'uno=a.hex', '--expect', 'x', '--expect', 'y', '--duration', '1s', '--report', 'r.json'])).toEqual({
      project: 'p.json',
      firmware: { uno: 'a.hex' },
      expect: ['x', 'y'],
      script: undefined,
      duration: '1s',
      report: 'r.json',
    });
    expect(() => parseRunArgs(['--firmware', 'uno'])).toThrow(/<board>=<path>/);
    expect(() => parseRunArgs(['p.json', '--bogus'])).toThrow(/unknown option/);
    expect(() => parseRunArgs([])).toThrow(/no project/);
  });
});
