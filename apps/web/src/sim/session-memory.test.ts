import type { ProjectDoc } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../../packages/esp32/src/test-support/rom.test-helper.ts';
import type { FromSim, MemoryReply, MemorySector } from './protocol.ts';
import { SimSession } from './session.ts';

// BT120: the worker reads a board's EEPROM or flash data (to save it with the project, and to show
// it: an EEPROM's bytes, an ESP32's NVS entries), puts saved data back when it loads a bench, and
// erases it.

function harness() {
  let wall = 0;
  let pending: (() => void) | null = null;
  const messages: FromSim[] = [];
  const session = new SimSession({ post: (message) => messages.push(structuredClone(message)), now: () => wall, schedule: (fn) => (pending = fn), esp32Rom: () => loadCachedRom() });
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
  const ask = (board: string, op: 'read' | 'erase'): MemoryReply => {
    const asked = ++id;
    session.handle({ type: 'memory', id: asked, board, op });
    const reply = messages.find((m): m is MemoryReply => m.type === 'memory' && m.id === asked);
    if (reply === undefined) throw new Error('no answer');
    return reply;
  };
  const serial = (board: string): string =>
    messages
      .filter((m): m is Extract<FromSim, { type: 'serial' }> => m.type === 'serial' && m.board === board)
      .map((m) => String.fromCharCode(...m.bytes))
      .join('');
  return { session, advance, ask, serial };
}

const uno: ProjectDoc = { format: 1, name: 'counter', parts: [{ id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} }], wires: [], firmware: {} } as unknown as ProjectDoc;
const counter = { uno: { format: 'hex' as const, text: readFixtureText('fixtures/firmware/uno/eeprom-counter.hex') } };

describe('SimSession memory (BT120)', () => {
  it('an EEPROM saved from one session counts on in the next; erase starts again', () => {
    const h = harness();
    expect(h.ask('uno', 'read')).toMatchObject({ ok: false, error: 'nothing is loaded' });
    h.session.handle({ type: 'load', doc: uno, firmware: counter });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(300);
    expect(h.serial('uno')).toBe('boot 1\r\n');
    const saved = h.ask('uno', 'read');
    expect(saved).toMatchObject({ ok: true, kind: 'eeprom', size: 1024, sectorSize: 256, eeprom: [[0, 1]] });
    const sectors = saved.sectors as MemorySector[];
    expect(sectors.map((s) => s.offset)).toEqual([0]);
    // Another session (a reload of the page) with the saved data.
    const next = harness();
    next.session.handle({ type: 'load', doc: uno, firmware: counter, memory: { uno: sectors } });
    next.session.handle({ type: 'run', speed: 1 });
    next.advance(300);
    expect(next.serial('uno')).toBe('boot 2\r\n');
    // An edit that starts the board afresh (a new firmware ref) gets the saved data too.
    const renamed = { ...uno, firmware: { uno: { kind: 'file', name: 'other.hex', format: 'hex' } } } as unknown as ProjectDoc;
    next.session.handle({ type: 'edit', doc: renamed, firmware: counter, memory: { uno: next.ask('uno', 'read').sectors as MemorySector[] } });
    next.advance(300);
    expect(next.serial('uno')).toBe('boot 2\r\nboot 3\r\n');
    expect(next.ask('uno', 'erase')).toMatchObject({ ok: true, sectors: [] });
    expect(next.ask('uno', 'read')).toMatchObject({ ok: true, eeprom: [], sectors: [] });
    expect(next.ask('nope', 'read')).toMatchObject({ ok: false, error: '"nope" isn\'t a board' });
    // Damaged saved data (a sector of the wrong size) is skipped, not thrown on.
    const third = harness();
    third.session.handle({ type: 'load', doc: uno, firmware: counter, memory: { uno: [{ offset: 0, bytes: new Uint8Array(3) }] } });
    third.session.handle({ type: 'run', speed: 1 });
    third.advance(300);
    expect(third.serial('uno')).toBe('boot 1\r\n');
  });

  it('a load of the same project keeps what the boards hold (fresher than a save); another project starts from what it is given', () => {
    const h = harness();
    h.session.handle({ type: 'load', doc: uno, firmware: counter });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(300);
    h.session.handle({ type: 'load', doc: uno, firmware: counter, keepMemory: true });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(300);
    expect(h.serial('uno')).toBe('boot 1\r\nboot 2\r\n');
    h.session.handle({ type: 'load', doc: uno, firmware: counter, keepMemory: false });
    h.session.handle({ type: 'run', speed: 1 });
    h.advance(300);
    expect(h.serial('uno')).toBe('boot 1\r\nboot 2\r\nboot 1\r\n'); // the count started again
  });

  it('an ESP32\'s NVS entries as the Inspector shows them', () => {
    const h = harness();
    const esp: ProjectDoc = { format: 1, name: 'prefs', parts: [{ id: 'esp', type: 'esp32-devkit-v1', x: 0, y: 0, rotation: 0, props: {} }], wires: [], firmware: {} } as unknown as ProjectDoc;
    h.session.handle({ type: 'load', doc: esp, firmware: { esp: { format: 'esp32-bin', app: readFixture('fixtures/firmware/esp32/prefs-types.bin'), partitions: readFixture('fixtures/firmware/esp32/prefs-types.partitions.bin') } } });
    h.session.handle({ type: 'run', speed: Number.POSITIVE_INFINITY });
    for (let i = 0; i < 200 && !h.serial('esp').includes('written'); i++) h.advance(50);
    const reply = h.ask('esp', 'read');
    expect(reply).toMatchObject({ ok: true, kind: 'flash', sectorSize: 4096 });
    expect(reply.sectors?.map((s) => s.offset)).toEqual([0x9000, 0xa000]);
    const entries = reply.nvs?.[0].entries ?? [];
    expect(reply.nvs?.[0]).toMatchObject({ partition: 'nvs', problems: [] });
    expect(entries.find((e) => e.key === 'long')).toEqual({ namespace: 'types', key: 'long', type: 'string', value: Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('') });
    expect(entries.find((e) => e.key === 'i64')).toEqual({ namespace: 'types', key: 'i64', type: 'i64', value: '-9000000000000000000' });
    expect(entries.find((e) => e.key === 'big')).toMatchObject({ type: 'blob', size: 5000, value: `${Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join('')}…` });
  }, 60_000);
});
