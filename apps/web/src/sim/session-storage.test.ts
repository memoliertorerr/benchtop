import type { ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import type { FromSim, StorageReply } from './protocol.ts';
import { SimSession } from './session.ts';

// BT91: the worker answers `storage` requests from the bench's part storage (a microSD card).

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
  let id = 0;
  const ask = (part: string, request: { op: 'list' } | { op: 'read' | 'remove'; path: string } | { op: 'write'; path: string; bytes: Uint8Array }): StorageReply => {
    const asked = ++id;
    session.handle({ type: 'storage', id: asked, part, ...request });
    const reply = messages.find((m): m is StorageReply => m.type === 'storage' && m.id === asked);
    if (reply === undefined) throw new Error('no answer');
    return reply;
  };
  return { session, advance, ask, messages };
}

const project = (name: string): ProjectDoc => JSON.parse(readFixtureText(`fixtures/projects/${name}.json`));
const hex = (name: string) => ({ format: 'hex' as const, text: readFixtureText(`fixtures/firmware/uno/${name}.hex`) });
const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

describe('SimSession storage (BT91)', () => {
  it('lists, reads, writes and removes the card\'s files; versions move with the firmware\'s writes', () => {
    const h = harness();
    expect(h.ask('sd', { op: 'list' })).toMatchObject({ ok: false, error: 'nothing is loaded' });
    h.session.handle({ type: 'load', doc: project('sd-log'), firmware: { uno: hex('sd-log') } });
    const first = h.ask('sd', { op: 'list' });
    expect(first.ok).toBe(true);
    expect(first.files?.map((f) => f.path)).toEqual(['CONFIG.TXT']);
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(1000);
    const after = h.ask('sd', { op: 'list' });
    expect(after.version).toBeGreaterThan(first.version);
    expect(after.files?.map((f) => f.path)).toEqual(['CONFIG.TXT', 'LOG.TXT', 'DATA', 'DATA/A.CSV']);
    expect(text(h.ask('sd', { op: 'read', path: 'log.txt' }).bytes)).toBe('line 0\r\nline 1\r\nline 2\r\n');
    expect(h.ask('sd', { op: 'read', path: 'nope.txt' })).toMatchObject({ ok: false, error: 'no file "nope.txt"' });
    expect(h.ask('sd', { op: 'write', path: 'notes/hello.txt', bytes: new TextEncoder().encode('hi') }).ok).toBe(true);
    expect(text(h.ask('sd', { op: 'read', path: 'NOTES/HELLO.TXT' }).bytes)).toBe('hi');
    expect(h.ask('sd', { op: 'remove', path: 'notes' }).ok).toBe(true);
    expect(h.ask('sd', { op: 'remove', path: 'notes' }).ok).toBe(false);
    expect(h.ask('uno', { op: 'list' })).toMatchObject({ ok: false, error: '"uno" keeps no files' });
  });
});
