import { describe, expect, it } from 'vitest';
import { MAX_LINE, SerialBuffer } from './serial-buffer.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const texts = (b: SerialBuffer) => b.lines.map((l) => `${l.text}${l.complete ? '⏎' : '…'}`);

describe('SerialBuffer', () => {
  it('splits lines across chunk boundaries, CR LF included', () => {
    const b = new SerialBuffer();
    b.append(bytes('hel'), 100);
    b.append(bytes('lo\r'), 200);
    b.append(bytes('\nwor'), 300);
    expect(texts(b)).toEqual(['hello⏎', 'wor…']);
    b.append(bytes('ld\n\n'), 400);
    expect(texts(b)).toEqual(['hello⏎', 'world⏎', '⏎']);
  });

  it('stamps each line with the time of its first byte', () => {
    const b = new SerialBuffer();
    b.append(bytes('a'), 1_000);
    b.append(bytes('b\nc'), 2_000);
    b.append(bytes('\n'), 3_000);
    expect(b.lines.map((l) => [l.text, l.t])).toEqual([
      ['ab', 1_000],
      ['c', 2_000],
    ]);
  });

  it('decodes UTF-8 split across chunks', () => {
    const b = new SerialBuffer();
    const all = bytes('°C ✓\n');
    b.append(all.subarray(0, 1), 0);
    b.append(all.subarray(1, 5), 0);
    b.append(all.subarray(5), 0);
    expect(texts(b)).toEqual(['°C ✓⏎']);
  });

  it('keeps about 1 MB, dropping the oldest lines', () => {
    const b = new SerialBuffer();
    const line = `${'x'.repeat(99)}\n`;
    for (let i = 0; i < 20_000; i++) b.append(bytes(line), i);
    const total = b.lines.reduce((n, l) => n + l.text.length, 0);
    expect(total).toBeLessThanOrEqual(1 << 20);
    expect(total).toBeGreaterThan((1 << 20) - 100);
    expect(b.dropped + b.lines.length).toBe(20_000);
    expect(b.lines[0].t).toBe(b.dropped);
  });

  it('cuts a line that never ends, and clears', () => {
    const b = new SerialBuffer(1 << 20);
    b.append(bytes('y'.repeat(MAX_LINE + 10)), 0);
    expect(b.lines.map((l) => [l.text.length, l.complete])).toEqual([
      [MAX_LINE, true],
      [10, false],
    ]);
    const v = b.version;
    b.clear();
    expect(b.lines).toEqual([]);
    expect(b.dropped).toBe(2);
    expect(b.version).toBeGreaterThan(v);
  });

  it('puts a marker on a line of its own, ending a partial line', () => {
    const b = new SerialBuffer();
    b.append(bytes('hel'), 1);
    b.mark('— reloaded —', 2);
    b.append(bytes('hello\n'), 3);
    expect(b.lines.map((l) => [l.text, l.t, l.complete])).toEqual([
      ['hel', 1, true],
      ['— reloaded —', 2, true],
      ['hello', 3, true],
    ]);
  });
});
