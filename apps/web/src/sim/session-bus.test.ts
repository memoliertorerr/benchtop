import type { ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import type { BusRow, FromSim } from './protocol.ts';
import { SimSession } from './session.ts';

// BT87: the session decodes the bench's bus log while the Bus tab watches and streams it in frames.

type Frame = Extract<FromSim, { type: 'frame' }>;

function harness() {
  let wall = 0;
  let pending: (() => void) | null = null;
  const messages: FromSim[] = [];
  const session = new SimSession({ post: (message) => messages.push(structuredClone(message)), now: () => wall, schedule: (fn) => (pending = fn) });
  const advance = (ms: number) => {
    const end = wall + ms;
    while (wall < end) {
      wall = Math.min(end, wall + 4);
      const fn = pending;
      pending = null;
      fn?.();
    }
  };
  const frames = () => messages.filter((m): m is Frame => m.type === 'frame');
  const rows = (from = 0): BusRow[] => frames().slice(from).flatMap((f) => f.bus?.rows ?? []);
  return { session, advance, frames, rows };
}

const project = (name: string): ProjectDoc => JSON.parse(readFixtureText(`fixtures/projects/${name}.json`));
const hex = (name: string) => ({ format: 'hex' as const, text: readFixtureText(`fixtures/firmware/uno/${name}.hex`) });

describe('SimSession bus streaming (BT87)', () => {
  it('nothing while nobody watches; then the transactions, labelled, with a restart first', () => {
    const h = harness();
    h.session.handle({ type: 'load', doc: project('lcd-i2c'), firmware: { uno: hex('lcd-i2c') } });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(100);
    expect(h.frames().every((f) => f.bus === undefined)).toBe(true);
    const before = h.frames().length;
    h.session.handle({ type: 'busWatch', on: true });
    h.advance(200);
    const chunks = h.frames().slice(before).flatMap((f) => (f.bus === undefined ? [] : [f.bus]));
    expect(chunks[0].restart).toBe(true);
    expect(chunks.slice(1).every((c) => !c.restart)).toBe(true);
    const rows = h.rows(before);
    // the history the log held (from boot) comes first
    expect(rows[0].t).toBeLessThan(100e6);
    const i2c = rows.filter((r) => r.bus === 'i2c');
    expect(i2c.length).toBeGreaterThan(20);
    expect(i2c[0]).toMatchObject({ label: 'lcd1 (I2C 0x27)', board: 'uno', part: 'lcd1', address: 0x27 });
    const serial = rows.filter((r) => r.bus === 'uart' && r.direction === 'tx');
    expect(serial.map((r) => (r.bus === 'uart' ? String.fromCharCode(...r.bytes) : '')).join('')).toContain('nack=2');
    h.session.handle({ type: 'busWatch', on: false });
    const off = h.frames().length;
    h.advance(100);
    expect(h.frames().slice(off).every((f) => f.bus === undefined)).toBe(true);
  });

  it('a reset restarts the list; an edit keeps it going', () => {
    const h = harness();
    h.session.handle({ type: 'busWatch', on: true });
    h.session.handle({ type: 'load', doc: project('lcd-i2c'), firmware: { uno: hex('lcd-i2c') } });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(200);
    const n = h.frames().length;
    h.session.handle({ type: 'reset' });
    h.advance(50);
    const after = h.frames().slice(n).flatMap((f) => (f.bus === undefined ? [] : [f.bus]));
    expect(after[0].restart).toBe(true);
    expect(after.flatMap((c) => c.rows).every((r) => r.t < 60e6)).toBe(true); // times from 0 again, nothing from before
    const m = h.frames().length;
    const doc = project('lcd-i2c');
    h.session.handle({ type: 'edit', doc: { ...doc, name: 'renamed', parts: [...doc.parts, { id: 'extra', type: 'led', x: 300, y: 300, rotation: 0, props: {} }] }, firmware: { uno: hex('lcd-i2c') } });
    h.advance(100);
    const edited = h.frames().slice(m).flatMap((f) => (f.bus === undefined ? [] : [f.bus]));
    expect(edited.every((c) => !c.restart)).toBe(true);
    expect(edited.flatMap((c) => c.rows).some((r) => r.bus === 'i2c')).toBe(true); // the sketch goes on writing
  });
});
