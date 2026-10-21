import { describe, expect, it } from 'vitest';
import { LineSplitter, parseLine } from './parse.ts';

describe('serial plotter parser (BT44)', () => {
  it('reads labeled, space-, comma- and tab-separated lines like the Arduino IDE 2 plotter', () => {
    expect(parseLine('a:1,b:2')).toEqual([
      { label: 'a', value: 1 },
      { label: 'b', value: 2 },
    ]);
    expect(parseLine('1 2 3')).toEqual([
      { label: 'value 1', value: 1 },
      { label: 'value 2', value: 2 },
      { label: 'value 3', value: 3 },
    ]);
    expect(parseLine('temp:23.5\thum:-4.5e1\r')).toEqual([
      { label: 'temp', value: 23.5 },
      { label: 'hum', value: -45 },
    ]);
    expect(parseLine('512')).toEqual([{ label: 'value 1', value: 512 }]);
    // Mixed: a label and a plain value.
    expect(parseLine('x:1 7')).toEqual([
      { label: 'x', value: 1 },
      { label: 'value 2', value: 7 },
    ]);
  });

  it('skips garbage: messages, half numbers, empty lines', () => {
    expect(parseLine('hello from esp32')).toEqual([]);
    expect(parseLine('')).toEqual([]);
    expect(parseLine('T=23.40 H=45.60')).toEqual([]);
    expect(parseLine('12abc 0x1F 5')).toEqual([{ label: 'value 1', value: 5 }]);
  });

  it('cuts a stream into lines across chunks and line endings', () => {
    const split = new LineSplitter();
    expect(split.push('1 2\r\n3')).toEqual(['1 2']);
    expect(split.push(' 4\n5\r6\r\n')).toEqual(['3 4', '5', '6']);
    expect(split.push('x'.repeat(5000))).toEqual([]);
    expect(split.push('\n')).toEqual(['']); // the runaway line was dropped
  });

  it('parses 1,000 lines in under 2 ms', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `sin:${Math.sin(i / 10).toFixed(3)},cos:${Math.cos(i / 10).toFixed(3)},n:${i}`);
    for (const line of lines) parseLine(line); // warm up
    let best = Number.POSITIVE_INFINITY;
    for (let k = 0; k < 5; k++) {
      const start = performance.now();
      for (const line of lines) parseLine(line);
      best = Math.min(best, performance.now() - start);
    }
    expect(best).toBeLessThan(2);
  });
});
