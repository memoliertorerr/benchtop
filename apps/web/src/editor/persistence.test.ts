import { emptyProject, parseProject } from '@benchtop/core';
import { describe, expect, it, vi } from 'vitest';
import { readFixtureText } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { AUTOSAVE_DELAY_MS, AUTOSAVE_KEY, createAutosave, loadAutosave, parseProjectText, serializeProject } from './persistence.ts';

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe('persistence', () => {
  it('round-trips a project through serializeProject and parseProject', () => {
    const doc = JSON.parse(readFixtureText('fixtures/projects/button-pullup.json'));
    const text = serializeProject(doc);
    const parsed = parseProjectText(text);
    expect(parsed).toEqual({ ok: true, doc });
    expect(parseProject(JSON.parse(text))).toEqual({ ok: true, doc });
  });

  it('autosaves after 500 ms of quiet and loads it back', () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const save = createAutosave(storage, { set: (fn, ms) => setTimeout(fn, ms) as unknown as number, clear: (id) => clearTimeout(id) });
      const a = emptyProject('a');
      const b = { ...emptyProject('b') };
      save.schedule(a);
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
      save.schedule(b);
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
      expect(storage.data.has(AUTOSAVE_KEY)).toBe(false);
      vi.advanceTimersByTime(1);
      expect(loadAutosave(storage)).toEqual(b);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a corrupt or invalid save, and storage that throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = memoryStorage();
      storage.setItem(AUTOSAVE_KEY, '{not json');
      expect(loadAutosave(storage)).toBeUndefined();
      storage.setItem(AUTOSAVE_KEY, JSON.stringify({ format: 2 }));
      expect(loadAutosave(storage)).toBeUndefined();
      const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
      expect(loadAutosave(throwing)).toBeUndefined();
      const save = createAutosave(throwing, { set: () => 1, clear: () => {} });
      save.schedule(emptyProject('x'));
      expect(() => save.flush()).not.toThrow();
      expect(loadAutosave(undefined)).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(parseProjectText('[]')).toEqual({ ok: false, error: '/ must be an object, got an array' });
  });
});
