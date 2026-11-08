import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { PartInput, ProjectDoc } from '@benchtop/core';
import { parseCardFiles } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, readFixtureText } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { MAX_FILE_STEP, runHeadless } from '../../../cli/src/run.ts';
import { parseSpec } from '../../../cli/src/spec.ts';
import { buildSpec, specFileName, timeText } from '../editor/test-spec.ts';
import { type FromSim, PROTOCOL_VERSION, type RecordedTest } from './protocol.ts';
import { MAX_RECORDED_FILE, quoted } from './recording.ts';
import { SimSession } from './session.ts';

// BT50: a test recorded in the worker session — running in real time, inputs arriving between
// ticks at whatever simulated instant — becomes a spec that the CLI replays exactly: the same
// serial output, and every proposed expectation holds.

function harness() {
  let wall = 0;
  let pending: (() => void) | null = null;
  const messages: FromSim[] = [];
  const session = new SimSession({ post: (m) => messages.push(structuredClone(m)), now: () => wall, schedule: (fn) => (pending = fn) });
  const advance = (ms: number): void => {
    const end = wall + ms;
    while (wall < end) {
      wall = Math.min(end, wall + 4);
      const fn = pending;
      pending = null;
      fn?.();
    }
  };
  const serial = (board: string): string =>
    messages
      .filter((m) => m.type === 'serial' && m.board === board)
      .map((m) => (m.type === 'serial' ? new TextDecoder().decode(m.bytes) : ''))
      .join('');
  return { session, messages, advance, serial };
}

/** Loads a fixture project, records `act` in real time, stops, and replays the spec in the CLI. */
function recordAndReplay(name: string, firmware: string, act: (h: ReturnType<typeof harness>) => void, edit?: (doc: ProjectDoc) => void, more: (test: RecordedTest) => string[] = () => []) {
  const h = harness();
  const doc = JSON.parse(readFixtureText(`fixtures/projects/${name}.json`)) as ProjectDoc;
  edit?.(doc);
  const fwPath = join(REPO_ROOT, 'fixtures', 'firmware', 'uno', `${firmware}.hex`);
  h.session.handle({ type: 'hello', protocol: PROTOCOL_VERSION });
  h.session.handle({ type: 'load', doc, firmware: { uno: { format: 'hex', text: readFileSync(fwPath, 'utf8') } } });
  h.session.handle({ type: 'run', speed: 1 });
  h.advance(137); // runs a while first: Record restarts from t = 0
  const start = h.messages.length;
  h.session.handle({ type: 'recordStart' });
  act(h);
  h.session.handle({ type: 'recordStop' });
  const recorded = h.messages.find((m) => m.type === 'recorded');
  if (recorded?.type !== 'recorded') throw new Error('no recording posted');
  const test: RecordedTest = recorded.test;
  const spec = buildSpec({ name: `${name} recorded`, doc, firmware: { uno: fwPath }, test, expectations: [...test.proposals, ...more(test)] });
  const parsed = parseSpec(JSON.parse(JSON.stringify(spec)), '/virtual/recorded.bench.json');
  const report = runHeadless(parsed.options, { readFile: (p) => new Uint8Array(readFileSync(p)), now: () => performance.now() });
  // What the session's serial monitor showed from the recording's start (its reset) to its end.
  const shown = h.messages
    .slice(start)
    .filter((m) => m.type === 'serial')
    .map((m) => (m.type === 'serial' ? new TextDecoder().decode(m.bytes) : ''))
    .join('');
  return { test, spec, report, shown };
}

const key = (k: string, down: boolean): PartInput => ({ kind: 'key', key: k, down });

describe('recording a test (BT50)', () => {
  it('keypad keys typed in real time: the replay prints the same and opens the same latch', () => {
    const { test, spec, report, shown } = recordAndReplay('keypad-lock', 'keypad-lock', (h) => {
      h.advance(150);
      for (const k of ['1', '2', '3', '4', '#']) {
        h.session.handle({ type: 'input', part: 'pad', event: key(k, true) });
        h.advance(61);
        h.session.handle({ type: 'input', part: 'pad', event: key(k, false) });
        h.advance(53);
      }
      h.advance(700);
    });
    expect(test.steps).toHaveLength(10);
    // Real-time steps land between whole milliseconds; the spec keeps them exact.
    expect(test.steps.every((s) => s.at > 0)).toBe(true);
    expect((spec.steps as { at: string }[])[0].at).toBe(timeText(test.steps[0].at));
    expect(test.durationNs % 1_000_000).toBe(0);
    expect(test.proposals).toEqual(expect.arrayContaining([expect.stringMatching(/^serial contains "unlocked" by \d+ms$/), expect.stringMatching(/^servo servo angle is 90 ±2 at \d+ms$/)]));
    expect(report.error).toBeNull();
    expect(report.assertions.filter((a) => !a.ok)).toEqual([]);
    expect(report.assertions).toHaveLength(test.proposals.length);
    expect(report.serial.uno).toBe(shown);
  });

  it('a knob turned, a button held, text typed into the serial monitor: same output, proposals hold', () => {
    const knob = recordAndReplay('servo-knob', 'servo-knob', (h) => {
      h.advance(400);
      h.session.handle({ type: 'input', part: 'pot', event: { kind: 'value', value: 0.25 } });
      h.advance(900);
    });
    expect(knob.test.proposals).toContainEqual(expect.stringMatching(/^servo servo angle is 4[3-7] ±2 at \d+ms$/));
    expect(knob.report.assertions.every((a) => a.ok)).toBe(true);

    const button = recordAndReplay('button-pullup', 'button-pullup', (h) => {
      h.advance(90);
      h.session.handle({ type: 'input', part: 'btn1', event: { kind: 'press' } });
      h.advance(200);
    });
    expect(button.test.proposals).toEqual(['led led1 is lit at ' + timeText(button.test.durationNs)]);
    expect(button.report.assertions.map((a) => a.ok)).toEqual([true]);

    const echo = recordAndReplay('debug-demo', 'serial-echo', (h) => {
      h.advance(80);
      h.session.handle({ type: 'serialSend', board: 'uno', bytes: new TextEncoder().encode('ping "7"\n') });
      h.advance(120);
    });
    expect(echo.test.steps).toEqual([{ at: expect.any(Number), board: 'uno', serial: 'ping "7"\n' }]);
    expect(echo.test.proposals).toEqual([expect.stringMatching(/^serial contains "ping \\"7\\"" by \d+ms$/)]);
    expect(echo.report.assertions.map((a) => a.ok)).toEqual([true]);
    expect(echo.report.serial.uno).toBe(echo.shown);
    expect(echo.shown).toBe('ping "7"\n');
  });

  it('an environment source switched from the Inspector is recorded like any input (BT55)', () => {
    const rec = recordAndReplay(
      'gas-meter',
      'gas-meter',
      (h) => {
        h.advance(300);
        h.session.handle({ type: 'input', part: 'leak', event: { kind: 'key', key: 'set:on=1', down: true } });
        h.advance(3200);
      },
      (doc) =>
        doc.parts.push(
          { id: 'room', type: 'environment', x: -150, y: 120, rotation: 0, props: { ventilation: 0 } },
          { id: 'leak', type: 'gas-leak', x: 79.1, y: 1.3, rotation: 0, props: { rate: 5, on: false } },
        ),
    );
    expect(rec.test.steps).toEqual([{ at: expect.any(Number), part: 'leak', input: { kind: 'key', key: 'set:on=1', down: true } }]);
    expect(rec.test.proposals).toContainEqual(expect.stringMatching(/^serial contains "a0=\d+ alarm=1" by \d+ms$/));
    expect(rec.report.error).toBeNull();
    expect(rec.report.assertions.every((a) => a.ok)).toBe(true);
    expect(rec.report.serial.uno).toBe(rec.shown);
  });

  it('files written and removed from the Inspector become write and remove steps that replay (BT144)', () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const rec = recordAndReplay(
      'sd-log',
      'sd-log',
      (h) => {
        h.advance(300);
        h.session.handle({ type: 'storage', id: 1, part: 'sd', op: 'write', path: 'NOTES/A.TXT', bytes: bytes('from the "inspector"\n') });
        h.advance(40);
        h.session.handle({ type: 'storage', id: 2, part: 'sd', op: 'write', path: 'BLOB.BIN', bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x41]) });
        h.session.handle({ type: 'storage', id: 3, part: 'sd', op: 'remove', path: 'CONFIG.TXT' });
        h.session.handle({ type: 'storage', id: 4, part: 'sd', op: 'remove', path: 'NOTHING.TXT' }); // refused: not a step
        h.session.handle({ type: 'storage', id: 5, part: 'sd', op: 'write', path: 'BIG.BIN', bytes: new Uint8Array(MAX_RECORDED_FILE + 1) });
        h.advance(100);
      },
      undefined,
      (test) => [`file sd NOTES/A.TXT contains "inspector" by ${timeText(test.durationNs)}`, `file sd BLOB.BIN contains "A" by ${timeText(test.durationNs)}`],
    );
    expect(MAX_RECORDED_FILE).toBe(MAX_FILE_STEP);
    const [write, blob, remove] = rec.test.steps;
    expect(rec.test.steps).toEqual([
      { at: expect.any(Number), part: 'sd', write: 'NOTES/A.TXT', text: 'from the "inspector"\n' },
      { at: expect.any(Number), part: 'sd', write: 'BLOB.BIN', base64: '//4AQQ==' },
      { at: expect.any(Number), part: 'sd', remove: 'CONFIG.TXT' },
    ]);
    expect(blob.at - write.at).toBeGreaterThanOrEqual(40e6);
    expect(remove.at).toBe(blob.at);
    expect(rec.test.droppedFiles).toBe(1);
    // The card ran 137 ms before Record (its LOG.TXT and DATA/A.CSV written); a reset keeps them,
    // so the spec's circuit starts the card with them and the replay prints the same.
    expect(Object.keys(rec.test.cards)).toEqual(['sd']);
    // (Record caught the sketch making DATA/: whatever the card held then, the replay starts from it.)
    expect(parseCardFiles(rec.test.cards.sd).files.map(([path, b]) => [path, b.length]).slice(0, 2)).toEqual([['CONFIG.TXT', 8], ['LOG.TXT', 24]]);
    expect(rec.test.cardsNotKept).toEqual([]);
    const card = (rec.spec.project as ProjectDoc).parts.find((p) => p.id === 'sd');
    expect(card?.props.files).toBe(rec.test.cards.sd);
    expect(rec.spec.steps).toEqual([
      { at: timeText(write.at), part: 'sd', write: 'NOTES/A.TXT', text: 'from the "inspector"\n' },
      { at: timeText(blob.at), part: 'sd', write: 'BLOB.BIN', base64: '//4AQQ==' },
      { at: timeText(remove.at), part: 'sd', remove: 'CONFIG.TXT' },
    ]);
    expect(rec.report.error).toBeNull();
    expect(rec.report.assertions.filter((a) => !a.ok)).toEqual([]);
    expect(rec.report.assertions.slice(-2).map((a) => a.ok)).toEqual([true, true]);
    expect(rec.report.serial.uno).toBe(rec.shown);
  });

  it('a reset or a new load ends a recording; stop without one posts nothing', () => {
    const h = harness();
    h.session.handle({ type: 'hello', protocol: PROTOCOL_VERSION });
    h.session.handle({ type: 'load', doc: JSON.parse(readFixtureText('fixtures/projects/blink-led.json')), firmware: { uno: { format: 'hex', text: readFixtureText('fixtures/firmware/uno/blink.hex') } } });
    h.session.handle({ type: 'recordStart' });
    h.session.handle({ type: 'reset' });
    h.session.handle({ type: 'recordStop' });
    expect(h.messages.some((m) => m.type === 'recorded')).toBe(false);
  });

  it('writes times exactly, quotes text for the grammar, and names files', () => {
    expect([timeText(2_000_000_000), timeText(1_500_000), timeText(1_234_000), timeText(1_234_567)]).toEqual(['2000ms', '1500us', '1234us', '1234567ns']);
    expect(quoted('say "hi"\\now\n')).toBe('"say \\"hi\\"\\\\now\\n"');
    expect(specFileName('Keypad lock — test #1')).toBe('keypad-lock-test-1.bench.json');
    expect(specFileName('!!!')).toBe('recorded-test.bench.json');
  });
});
