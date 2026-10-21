import { describe, expect, it } from 'vitest';
import { Backoff, SseParser } from './bridge-sse.ts';

describe('SSE parser', () => {
  it('parses events, ignoring comments and unknown fields', () => {
    const p = new SseParser();
    expect(p.push(': benchtop bridge\n\nevent: compile-start\ndata: {"a":1}\n\nid: 7\nretry: 10\ndata: plain\n\n')).toEqual([
      { event: 'compile-start', data: '{"a":1}' },
      { event: 'message', data: 'plain' },
    ]);
  });

  it('assembles events split across chunks at every position', () => {
    const stream = 'event: compile-start\ndata: {"sketch":"/a/b"}\n\n: keep-alive\n\nevent: compile-result\ndata: {"ok":true}\n\n';
    const whole = new SseParser().push(stream);
    expect(whole).toHaveLength(2);
    for (let cut = 1; cut < stream.length; cut++) {
      const p = new SseParser();
      expect([...p.push(stream.slice(0, cut)), ...p.push(stream.slice(cut))], `cut at ${cut}`).toEqual(whole);
    }
    const p = new SseParser();
    expect([...stream].flatMap((c) => p.push(c))).toEqual(whole);
  });

  it('accepts CR LF and CR line endings, even with CR LF split between chunks', () => {
    const p = new SseParser();
    expect(p.push('event: x\r\ndata: 1\r')).toEqual([]);
    expect(p.push('\n\r\n')).toEqual([{ event: 'x', data: '1' }]);
    expect(p.push('data: 2\r\r')).toEqual([{ event: 'message', data: '2' }]);
  });

  it('joins multi-line data, keeps colons in values, and drops events without data', () => {
    const p = new SseParser();
    expect(p.push('event: nothing\n\ndata:a\ndata: b: c\ndata\n\n')).toEqual([{ event: 'message', data: 'a\nb: c\n' }]);
  });

  it('forgets a partial event on reset', () => {
    const p = new SseParser();
    p.push('event: compile-result\ndata: {"ok":');
    p.reset();
    expect(p.push('data: fresh\n\n')).toEqual([{ event: 'message', data: 'fresh' }]);
  });
});

describe('reconnect backoff', () => {
  it('doubles from 1 s to a 30 s cap and starts over after reset', () => {
    const b = new Backoff();
    expect(Array.from({ length: 8 }, () => b.next())).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
    b.reset();
    expect(b.next()).toBe(1000);
  });
});
