import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { parseAssertion, type RunIo, type RunReport, runHeadless } from './run.ts';

// BT49: the richer expectations — parts' visual state, pin timing over a window, serial regexes —
// each on committed fixture firmware, passing and failing with what was seen instead.

const io: RunIo = { readFile: (path) => readFileSync(resolve(REPO_ROOT, path)), now: () => performance.now() };

function run(project: string, firmware: string, expectations: string[], extra: { scriptJson?: unknown; duration?: string } = {}): RunReport {
  return runHeadless({ project: `fixtures/projects/${project}.json`, firmware: { uno: `fixtures/firmware/uno/${firmware}.hex` }, expect: expectations, ...extra }, io);
}

const verdicts = (r: RunReport) => r.assertions.map((a) => [a.text, a.ok, a.detail]);

describe('visual expectations', () => {
  it('led <part> is lit | dark', () => {
    const r = run('blink-led', 'blink', ['led led1 is lit at 250ms', 'led led1 is dark at 750ms', 'led led1 is dark at 1250ms']);
    expect(r.error).toBeNull();
    expect(verdicts(r)).toEqual([
      ['led led1 is lit at 250ms', true, 'brightness 0.91'], // 220 Ω: brightness follows the current
      ['led led1 is dark at 750ms', true, 'brightness 0.00'],
      ['led led1 is dark at 1250ms', false, 'brightness 0.91'],
    ]);
  });

  it('servo <part> angle is <deg> ±<tol>, following a knob turned by a step', () => {
    const r = run('servo-knob', 'servo-knob', ['servo servo angle is 90 ±3 at 1s', 'servo servo angle is 45° +- 3° at 2s', 'servo servo angle is 180 ±3 at 2s'], {
      scriptJson: [{ at: '1s', part: 'pot', input: { kind: 'value', value: 0.25 } }],
    });
    expect(r.error).toBeNull();
    expect(r.assertions.map((a) => a.ok)).toEqual([true, true, false]);
    expect(r.assertions[2].detail).toMatch(/^angle 4[3-7](\.\d+)?°$/);
  });

  it('lcd <part> row <n> is "<text>" (trailing spaces ignored; rows from 0)', () => {
    const r = run('lcd-4bit', 'lcd-4bit', ['lcd lcd1 row 0 is "Hello, Benchtop!" at 1200ms', 'lcd lcd1 row 1 is "t=1" at 1200ms', 'lcd lcd1 row 1 is "t=9" at 1200ms']);
    expect(verdicts(r)).toEqual([
      ['lcd lcd1 row 0 is "Hello, Benchtop!" at 1200ms', true, 'row 0 is "Hello, Benchtop!"'],
      ['lcd lcd1 row 1 is "t=1" at 1200ms', true, 'row 1 is "t=1"'],
      ['lcd lcd1 row 1 is "t=9" at 1200ms', false, 'row 1 is "t=1"'],
    ]);
  });

  it('pixel <part>[<i>] is #rrggbb (the sketch sets pixel i to ((i·37+16), (255−i·9), (i·73)) & 255)', () => {
    const r = run('neopixel', 'neopixel', ['pixel strip[0] is #10ff00 at 600ms', 'pixel strip[7] is #13C0FF at 600ms', 'pixel ring[0] is #38b748 at 600ms', 'pixel ring[0] is #000000 at 600ms', 'pixel ring[99] is #000000 at 600ms']);
    expect(verdicts(r)).toEqual([
      ['pixel strip[0] is #10ff00 at 600ms', true, '#10ff00'],
      ['pixel strip[7] is #13C0FF at 600ms', true, '#13c0ff'],
      ['pixel ring[0] is #38b748 at 600ms', true, '#38b748'],
      ['pixel ring[0] is #000000 at 600ms', false, '#38b748'],
      ['pixel ring[99] is #000000 at 600ms', false, 'it has 16 pixels'],
    ]);
  });

  it('digits <part> show "<text>"', () => {
    const r = run('seven-seg-mux', 'seven-seg-mux', ['digits disp show "1234" at 2s', 'digits disp shows "4321" at 2s']);
    expect(verdicts(r)).toEqual([
      ['digits disp show "1234" at 2s', true, 'shows "1234"'],
      ['digits disp shows "4321" at 2s', false, 'shows "1234"'],
    ]);
  });

  it('refuses a visual expectation on the wrong kind of part, or an LCD row it lacks', () => {
    const cases: [string, RegExp][] = [
      ['servo led1 angle is 90 ±1 at 1s', /"led1" is a led, not a servo/],
      ['led uno is lit at 1s', /"uno" is a arduino-uno, not an LED/],
      ['lcd led1 row 0 is "x" at 1s', /not a character LCD/],
      ['pixel led1[0] is #000000 at 1s', /not a NeoPixel/],
      ['digits led1 show "1" at 1s', /not a 7-segment display/],
      ['led nope is lit at 1s', /no part "nope"/],
    ];
    for (const [text, message] of cases) expect(run('blink-led', 'blink', [text]).error, text).toMatch(message);
    expect(run('lcd-4bit', 'lcd-4bit', ['lcd lcd1 row 2 is "x" at 1s']).error).toMatch(/a lcd1602 has rows 0–1/);
  });
});

describe('pin timing over a window', () => {
  // logic-demo: D9 is analogWrite(9, 64) — 490.2 Hz, high 512 µs of 2040.8 (25.1 %); D7 toggles
  // on a 1 ms schedule (500 Hz), but each rising edge is followed by a SoftwareSerial byte sent
  // with interrupts off, which holds the falling edge back by ~62 µs: 53.1 % high.
  it('pin … frequency is <hz> ±<pct>% and duty is <pct>% ±<pct>', () => {
    const r = run('logic-demo', 'logic-demo', [
      'pin uno:9 frequency is 490.2 Hz ±0.5% between 100ms and 600ms',
      'pin uno:9 duty is 25.1% ±0.5 between 100ms and 600ms',
      'pin uno:D7 frequency is 500 ±0.1% between 50ms and 1s',
      'pin uno:7 duty is 53.1% ±0.5% between 50ms and 1s',
      'pin uno:9 frequency is 1000 ±5% between 100ms and 600ms',
      'pin uno:9 duty is 75% ±1 between 100ms and 600ms',
    ]);
    expect(r.error).toBeNull();
    expect(r.assertions.map((a) => a.ok)).toEqual([true, true, true, true, false, false]);
    expect(r.assertions[0].detail).toMatch(/^measured 490\.\d\d Hz$/);
    expect(r.assertions[1].detail).toMatch(/^measured 25\.\d\d %$/);
    expect(r.assertions[4].detail).toMatch(/^measured 490\.\d\d Hz$/);
  });

  it('a steady pin has no frequency; a window spanning many drains stays exact', () => {
    const r = run('blink-led', 'blink', ['pin uno:13 frequency is 1 ±10% between 100ms and 400ms', 'pin uno:13 duty is 50% ±0.1 between 0ms and 3s', 'pin uno:13 frequency is 1 ±0.1% between 0ms and 3s']);
    expect(verdicts(r)).toEqual([
      ['pin uno:13 frequency is 1 ±10% between 100ms and 400ms', false, '0 rising edges between 100 ms and 400 ms'],
      ['pin uno:13 duty is 50% ±0.1 between 0ms and 3s', true, expect.stringMatching(/^measured (49\.9\d|50\.0\d) %$/)],
      ['pin uno:13 frequency is 1 ±0.1% between 0ms and 3s', true, expect.stringMatching(/^measured 1\.00 Hz$/)],
    ]);
  });
});

describe('serial matches /regex/', () => {
  it('passes at the time the first match ends; fails past `by` or with no match', () => {
    const r = run('cli-demo', 'cli-demo', ['serial matches /pres+ed/ by 2s', 'serial matches /^boot$/m by 50ms', 'serial matches /PRESSED/i by 50ms', 'serial matches /never \\d+/ by 2s'], {
      scriptJson: [{ at: '100ms', part: 'btn1', input: { kind: 'press' } }],
    });
    expect(r.error).toBeNull();
    expect(r.assertions.map((a) => a.ok)).toEqual([true, true, false, false]);
    expect(r.assertions[0].detail).toMatch(/^matched "pressed" at 10\d(\.\d+)? ms$/);
    expect(r.assertions[0].atNs).toBeGreaterThan(100e6);
    expect(r.assertions[2].detail).toMatch(/^matched "pressed" at .* ms, after 50 ms$/);
    expect(r.assertions[3].detail).toBe('no match by 2 s');
  });

  it('refuses stateful flags, broken patterns and oversized ones', () => {
    expect(() => parseAssertion('serial matches /x/g by 1s')).toThrow(/flags may be i, m, s and u/);
    expect(() => parseAssertion('serial matches /(/ by 1s')).toThrow(/Invalid regular expression|Unterminated group/);
    expect(() => parseAssertion(`serial matches /${'a'.repeat(1025)}/ by 1s`)).toThrow(/longer than 1024/);
  });
});

describe('grammar of the new forms', () => {
  it('parses each, with ± or +- and optional units', () => {
    expect(parseAssertion('led led1 is lit at 1s')).toMatchObject({ kind: 'led', part: 'led1', lit: true, at: 1e9 });
    expect(parseAssertion('servo s angle is -10.5 +- 2 at 3ms')).toMatchObject({ kind: 'servo', angle: -10.5, tolerance: 2, at: 3e6 });
    expect(parseAssertion('lcd l row 3 is "a \\"b\\"" at 1s')).toMatchObject({ kind: 'lcd', row: 3, expected: 'a "b"' });
    expect(parseAssertion('pixel ring[15] is #FfA500 at 1s')).toMatchObject({ kind: 'pixel', part: 'ring', index: 15, rgb: 0xffa500 });
    expect(parseAssertion('digits d show " 1.2" at 1s')).toMatchObject({ kind: 'digits', expected: ' 1.2' });
    expect(parseAssertion('pin uno:9 frequency is 490 ±1% between 1ms and 2ms')).toMatchObject({ kind: 'frequency', hz: 490, percent: 1, from: 1e6, to: 2e6 });
    expect(parseAssertion('pin uno:9 duty is 25% +/- 2% between 1ms and 2ms')).toMatchObject({ kind: 'duty', percent: 25, tolerance: 2 });
    expect(parseAssertion('serial[esp] matches /a\\/b/i by 1s')).toMatchObject({ kind: 'match', board: 'esp' });
  });

  it('refuses empty windows and impossible duties, and lists the forms otherwise', () => {
    expect(() => parseAssertion('pin uno:9 duty is 25% ±2 between 2ms and 1ms')).toThrow(/must end after it starts/);
    expect(() => parseAssertion('pin uno:9 duty is 125% ±2 between 1ms and 2ms')).toThrow(/at most 100 %/);
    expect(() => parseAssertion('pin uno:9 frequency is 0 ±2% between 1ms and 2ms')).toThrow(/above 0 Hz/);
    expect(() => parseAssertion('led led1 glows at 1s')).toThrow(/not an assertion: .*led <part> is <lit\|dark> at <time>/);
  });
});
