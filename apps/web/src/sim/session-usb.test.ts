import type { ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { loadCachedS3Rom } from '../../../../packages/esp32s3/src/test-support/rom.test-helper.ts';
import type { FromSim, UsbReply } from './protocol.ts';
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
});
