import { join } from 'node:path';
import type { ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, readFixture, readFixtureText } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { loadCachedS3Rom } from '../../../../packages/esp32s3/src/test-support/rom.test-helper.ts';
import { nodeIo } from '../../../cli/src/node-io.ts';
import { runHeadless } from '../../../cli/src/run.ts';
import { parseSpec } from '../../../cli/src/spec.ts';
import { buildSpec } from '../editor/test-spec.ts';
import type { FromSim, UsbReply, UsbSentReply } from './protocol.ts';
import { SimSession } from './session.ts';

// BT139: the worker answers a `usb` request with a board's USB host view (Bench.usbOf) — what the
// Inspector's USB section shows.

describe('SimSession usb (BT139)', () => {
  it('nothing loaded, a part that isn’t a board, a board before its firmware starts USB, then what a keyboard typed', () => {
    let wall = 0;
    let pending: (() => void) | null = null;
    const messages: FromSim[] = [];
    const session = new SimSession({ post: (message) => messages.push(structuredClone(message)), now: () => wall, schedule: (fn) => (pending = fn), esp32s3Rom: () => loadCachedS3Rom() });
    const advance = (ms: number) => {
      const end = wall + ms;
      while (wall < end) {
        wall = Math.min(end, wall + 4);
        const fn = pending;
        pending = null;
        fn?.();
      }
    };
    let id = 0;
    const ask = (board: string): UsbReply => {
      const asked = ++id;
      session.handle({ type: 'usb', id: asked, board });
      const reply = messages.find((m): m is UsbReply => m.type === 'usb' && m.id === asked);
      if (reply === undefined) throw new Error('no answer');
      return reply;
    };
    expect(ask('s3')).toEqual({ type: 'usb', id: 1, board: 's3', ok: false, error: 'nothing is loaded' });
    const doc = JSON.parse(readFixtureText('fixtures/projects/esp32s3-usb-keys.json')) as ProjectDoc;
    session.handle({ type: 'load', doc, firmware: { s3: { format: 'esp32-bin', app: readFixture('fixtures/firmware/esp32s3/usb-keys.bin'), partitions: readFixture('fixtures/firmware/esp32s3/usb-keys.partitions.bin') } } });
    expect(ask('s3')).toMatchObject({ ok: true, usb: null });
    expect(ask('type')).toMatchObject({ ok: false, error: '"type" isn\'t a board' });
    session.handle({ type: 'run', speed: 1 });
    advance(400);
    session.handle({ type: 'input', part: 'type', event: { kind: 'press' } });
    advance(150);
    const reply = ask('s3');
    expect(reply).toMatchObject({ ok: true, usb: { phase: 'running', device: 'ESP32S3_DEV', functions: ['serial (CDC-ACM)', 'keyboard', 'mouse', 'media keys'], typed: 'Hello from Benchtop!\n', events: [] } });
  }, 60_000);

  it('BT146: usbSend — MIDI to the synth, the lock keys — answered and recorded as midi and locks steps that replay', () => {
    let wall = 0;
    let pending: (() => void) | null = null;
    const messages: FromSim[] = [];
    const session = new SimSession({ post: (message) => messages.push(structuredClone(message)), now: () => wall, schedule: (fn) => (pending = fn), esp32s3Rom: () => loadCachedS3Rom() });
    const advance = (ms: number) => {
      const end = wall + ms;
      while (wall < end) {
        wall = Math.min(end, wall + 4);
        const fn = pending;
        pending = null;
        fn?.();
      }
    };
    let id = 0;
    const send = (board: string, what: { midi: Uint8Array } | { locks: { num: boolean; caps: boolean; scroll: boolean } }): UsbSentReply => {
      const asked = ++id;
      session.handle({ type: 'usbSend', id: asked, board, ...what });
      const reply = messages.find((m): m is UsbSentReply => m.type === 'usbSent' && m.id === asked);
      if (reply === undefined) throw new Error('no answer');
      return reply;
    };
    expect(send('s3', { midi: new Uint8Array([0x90, 60, 100]) })).toEqual({ type: 'usbSent', id: 1, board: 's3', ok: false, error: 'nothing is loaded' });
    const doc = JSON.parse(readFixtureText('fixtures/projects/esp32s3-usb-synth.json')) as ProjectDoc;
    session.handle({ type: 'load', doc, firmware: { s3: { format: 'esp32-bin', app: readFixture('fixtures/firmware/esp32s3/usb-synth.bin'), partitions: readFixture('fixtures/firmware/esp32s3/usb-synth.partitions.bin') } } });
    session.handle({ type: 'run', speed: 1 });
    session.handle({ type: 'recordStart' });
    expect(send('s3', { midi: new Uint8Array([0x90, 60, 100]) })).toMatchObject({ ok: false, error: "no USB device on the board's port (the firmware hasn't started USB)" });
    advance(600);
    expect(send('speaker', { midi: new Uint8Array([0x90, 60, 100]) })).toMatchObject({ ok: false, error: '"speaker" isn\'t a board' });
    expect(send('s3', { midi: new Uint8Array([0x90, 60]) })).toMatchObject({ ok: false, error: 'the message at byte 1 (90) needs 2 data bytes' });
    expect(send('s3', { midi: new Uint8Array([0x90, 69, 100]) })).toMatchObject({ ok: true });
    advance(150);
    expect(send('s3', { locks: { num: false, caps: true, scroll: false } })).toMatchObject({ ok: true }); // the host's, keyboard or not
    expect(send('s3', { midi: new Uint8Array([0x80, 69, 0, 0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]) })).toMatchObject({ ok: true });
    advance(150);
    session.handle({ type: 'recordStop' });
    const recorded = messages.find((m) => m.type === 'recorded');
    if (recorded?.type !== 'recorded') throw new Error('no recording');
    const steps = recorded.test.steps;
    expect(steps).toEqual([
      { at: expect.any(Number), board: 's3', midi: '90 45 64' },
      { at: expect.any(Number), board: 's3', locks: ['caps'] },
      { at: expect.any(Number), board: 's3', midi: '80 45 00 F0 7E 7F 06 01 F7' },
    ]);
    expect(recorded.test.proposals).toContainEqual(expect.stringMatching(/^serial contains "note on 69 100" by \d+ms$/));
    const fw = join(REPO_ROOT, 'fixtures/firmware/esp32s3/usb-synth.bin');
    const spec = buildSpec({ name: 'synth recorded', doc, firmware: { s3: fw }, test: recorded.test, expectations: recorded.test.proposals });
    expect((spec.steps as unknown[])[1]).toEqual({ at: expect.stringMatching(/^\d+(ms|us|ns)$/), board: 's3', locks: ['caps'] });
    const report = runHeadless(parseSpec(JSON.parse(JSON.stringify(spec)), '/virtual/synth.bench.json').options, nodeIo);
    expect(report.error).toBeNull();
    expect(report.assertions.filter((a) => !a.ok)).toEqual([]);
    expect(report.serial.s3).toContain('note on 69 100\nnote off 69\nsysex F0 7E 7F 06 01 F7\r\n');
  }, 60_000);
});
