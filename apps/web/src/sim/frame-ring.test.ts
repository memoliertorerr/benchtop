import { Worker } from 'node:worker_threads';
import { type ProjectDoc, NS_PER_MS, type VisualState } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { createFrameRingBuffer, FrameRingReader, FrameRingWriter, SLOT_BYTES } from './frame-ring.ts';
import type { FromSim } from './protocol.ts';
import { SimSession } from './session.ts';

const PARTS = ['led1', 'uno', 'oled'];

function ring(slotBytes = SLOT_BYTES) {
  const buffer = createFrameRingBuffer(PARTS.length, slotBytes);
  return { buffer, writer: new FrameRingWriter(buffer, PARTS), reader: new FrameRingReader(buffer, PARTS) };
}

/** The raw sequence word of a slot (header is 4 words, then [seq, length] per slot). */
const seqWord = (slot: number) => 4 + 2 * slot;

describe('frame ring', () => {
  it('hands the reader each changed part once, newest state only', () => {
    const { writer, reader } = ring();
    expect(reader.drain()).toEqual([]);
    expect(writer.write('led1', { brightness: 0.5 })).toBe(true);
    expect(writer.write('oled', { on: true, fb: [1, 2, 3], text: 'héllo ✓' })).toBe(true);
    expect(reader.drain()).toEqual([
      ['led1', { brightness: 0.5 }],
      ['oled', { on: true, fb: [1, 2, 3], text: 'héllo ✓' }],
    ]);
    expect(reader.drain()).toEqual([]);
    // The writer laps the reader: three writes, one read, the last state.
    for (const b of [0.1, 0.2, 0.3]) writer.write('led1', { brightness: b });
    expect(reader.drain()).toEqual([['led1', { brightness: 0.3 }]]);
    expect(writer.write('nope', { x: 1 })).toBe(false);
  });

  it('keeps working when the sequence counter wraps around 2³¹ and 2³²', () => {
    const { buffer, writer, reader } = ring();
    const words = new Int32Array(buffer);
    words[seqWord(0)] = 0x7fff_fffe; // even: stable, two writes from the Int32 wrap
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      writer.write('led1', { brightness: i });
      seen.push(reader.read(0)?.brightness as number);
    }
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(words[seqWord(0)]).toBe(-0x7fff_fffa); // wrapped, still even
    words[seqWord(1)] = -2; // 0xfffffffe: the next write wraps to 0 and on
    writer.write('uno', { ledOn: true });
    expect(words[seqWord(1)]).toBe(0);
    // 0 is also "never written" for a fresh reader, but this reader saw nothing in slot 1 yet
    // either way: a fresh reader is the only one that could miss it, and it then reads the next.
    writer.write('uno', { ledOn: false });
    expect(reader.read(1)).toEqual({ ledOn: false });
  });

  it('never returns a torn state: a write during the copy makes the reader retry', () => {
    const { buffer, writer } = ring();
    writer.write('oled', { fb: [1, 1, 1, 1] });
    let interleave = true;
    class Interleaved extends FrameRingReader {
      protected override copy(slot: number, length: number): void {
        super.copy(slot, length);
        // The writer runs between the copy and the second sequence load.
        if (interleave) {
          interleave = false;
          writer.write('oled', { fb: [2, 2, 2, 2] });
        }
      }
    }
    const reader = new Interleaved(buffer, PARTS);
    expect(reader.read(2)).toEqual({ fb: [2, 2, 2, 2] });
    expect(reader.read(2)).toBeUndefined();
  });

  it('leaves a slot that is being written for the next read', () => {
    const { buffer, writer, reader } = ring();
    writer.write('led1', { brightness: 1 });
    reader.drain();
    const words = new Int32Array(buffer);
    writer.write('led1', { brightness: 0.25 });
    Atomics.add(words, seqWord(0), 1); // a write in progress (odd)
    expect(reader.read(0)).toBeUndefined();
    Atomics.add(words, seqWord(0), 1); // finished
    expect(reader.read(0)).toEqual({ brightness: 0.25 });
  });

  it('refuses states that do not fit or JSON would change, and marks the slot empty', () => {
    const { writer, reader } = ring(64);
    expect(writer.write('led1', { brightness: 1 })).toBe(true);
    expect(writer.write('led1', { fb: new Array<number>(64).fill(255) })).toBe(false);
    // The older state is gone: the newer one went by message and must not be overwritten.
    expect(reader.drain()).toEqual([]);
    expect(writer.write('led1', { brightness: Number.NaN })).toBe(false);
    expect(writer.write('led1', { frequency: Number.POSITIVE_INFINITY })).toBe(false);
    expect(writer.write('led1', { brightness: 0 })).toBe(true);
    expect(reader.drain()).toEqual([['led1', { brightness: 0 }]]);
  });

  it('rejects a buffer that is not a ring for these parts', () => {
    const buffer = createFrameRingBuffer(2);
    expect(() => new FrameRingReader(buffer, PARTS)).toThrow(RangeError);
    expect(() => new FrameRingReader(new SharedArrayBuffer(8), PARTS)).toThrow(RangeError);
    expect(() => createFrameRingBuffer(2, 30)).toThrow(RangeError);
  });

  it('reads only consistent states while another thread writes flat out', async () => {
    const { buffer, reader } = ring();
    const count = 20_000;
    const worker = new Worker(new URL('./frame-ring-writer.test-helper.ts', import.meta.url), { workerData: { buffer, parts: PARTS, count } });
    const done = new Promise<void>((resolve, reject) => {
      worker.once('message', () => resolve());
      worker.once('error', reject);
    });
    let finished = false;
    void done.then(() => (finished = true));
    const last = new Map<string, number>();
    let reads = 0;
    const check = (part: string, v: VisualState) => {
      const n = v.n as number;
      const a = v.a as readonly number[];
      expect(a.length).toBe(300);
      expect(a.every((x) => x === n)).toBe(true);
      expect(v.s).toBe('x'.repeat(n % 97));
      expect(n).toBeGreaterThanOrEqual(last.get(part) ?? 0);
      last.set(part, n);
      reads++;
    };
    while (!finished) {
      for (const [part, v] of reader.drain()) check(part, v);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await done;
    for (const [part, v] of reader.drain()) check(part, v);
    await worker.terminate();
    // Every slot ends on the last state, and plenty were read on the way.
    expect([...last.values()]).toEqual([count, count, count]);
    expect(reads).toBeGreaterThan(3);
  });
});

describe('SimSession with shared memory', () => {
  const project = (name: string): ProjectDoc => JSON.parse(readFixtureText(`fixtures/projects/${name}.json`));
  const hex = (name: string) => ({ format: 'hex' as const, text: readFixtureText(`fixtures/firmware/uno/${name}.hex`) });

  function run(sharedMemory: boolean) {
    let wall = 0;
    let pending: (() => void) | null = null;
    const messages: FromSim[] = [];
    let reader: FrameRingReader | null = null;
    const led: { t: number; b: number }[] = [];
    const session = new SimSession({
      post: (message) => {
        messages.push(message);
        if (message.type === 'frameRing') reader = new FrameRingReader(message.buffer, message.parts);
        if (message.type !== 'frame') return;
        // What the UI's visual listeners get: the frame's parts, then the ring's changed slots.
        const parts = [...message.parts, ...(reader?.drain() ?? [])];
        for (const [id, v] of parts) if (id === 'led1') led.push({ t: message.t / NS_PER_MS, b: v.brightness as number });
      },
      now: () => wall,
      schedule: (fn) => {
        pending = fn;
      },
      sharedMemory,
    });
    session.handle({ type: 'load', doc: project('blink-led'), firmware: { uno: hex('blink') } });
    session.handle({ type: 'run', speed: 1 });
    while (wall < 1200) {
      wall += 4;
      const fn = pending as (() => void) | null;
      pending = null;
      fn?.();
    }
    const frames = messages.filter((m) => m.type === 'frame');
    return { messages, frames, led: led.map((l) => ({ t: l.t, lit: l.b > 0.5 ? 1 : 0 })) };
  }

  // One run per path, shared by the two tests (each is a second of blink on the real CPU core).
  let sharedRun: ReturnType<typeof run> | undefined;
  const shared = () => (sharedRun ??= run(true));

  it('publishes part state in the ring and keeps frames for time, stats and probes', () => {
    const ring = shared();
    // The ring arrives before anything is written to it.
    expect(ring.messages.map((m) => m.type).slice(0, 3)).toEqual(['frameRing', 'loaded', 'frame']);
    const ringMessage = ring.messages.find((m) => m.type === 'frameRing');
    expect(ringMessage?.type === 'frameRing' && ringMessage.parts).toEqual(['uno', 'bb', 'r1', 'led1']);
    expect(ring.frames.every((f) => f.type === 'frame' && f.parts.length === 0)).toBe(true);
    expect(ring.led.map((l) => l.lit)).toEqual([0, 1, 0, 1]);
  });

  it("keeps a speaker's audio blocks in frame messages (a stream; the ring keeps only the latest state)", () => {
    let wall = 0;
    let pending: (() => void) | null = null;
    let samples = 0;
    let ringAudio = 0;
    let reader: FrameRingReader | null = null;
    const session = new SimSession({
      post: (message) => {
        if (message.type === 'frameRing') reader = new FrameRingReader(message.buffer, message.parts);
        if (message.type !== 'frame') return;
        for (const [id, v] of message.parts) if (id === 'spk1' && Array.isArray(v.audio)) samples += v.audio.length;
        for (const [, v] of reader?.drain() ?? []) if ('audio' in v) ringAudio++;
      },
      now: () => wall,
      schedule: (fn) => {
        pending = fn;
      },
      sharedMemory: true,
    });
    session.handle({ type: 'load', doc: project('speaker-melody'), firmware: { uno: hex('speaker-melody') } });
    session.handle({ type: 'run', speed: 1 });
    while (wall < 1000) {
      wall += 4;
      const fn = pending as (() => void) | null;
      pending = null;
      fn?.();
    }
    // Three notes of 250 ms: ≈ 16 blocks of 1,024 samples at 22,050 Hz, all of them by message.
    expect(samples % 1024).toBe(0);
    expect(samples).toBeGreaterThanOrEqual(15 * 1024);
    expect(ringAudio).toBe(0);
  });

  it("keeps a TFT's framebuffer updates in frame messages, small once the picture is up (BT51)", () => {
    let wall = 0;
    let pending: (() => void) | null = null;
    let ringTft = 0;
    let reader: FrameRingReader | null = null;
    const updates: { wall: number; numbers: number; full: boolean }[] = [];
    const session = new SimSession({
      post: (message) => {
        if (message.type === 'frameRing') reader = new FrameRingReader(message.buffer, message.parts);
        if (message.type !== 'frame') return;
        for (const [id, v] of message.parts) {
          if (id === 'tft' && Array.isArray(v.tftPixels)) updates.push({ wall, numbers: v.tftPixels.length, full: v.tftFull === true });
        }
        for (const [, v] of reader?.drain() ?? []) if ('tftPixels' in v) ringTft++;
      },
      now: () => wall,
      schedule: (fn) => {
        pending = fn;
      },
      sharedMemory: true,
    });
    session.handle({ type: 'load', doc: project('tft-demo'), firmware: { uno: hex('tft-demo') } });
    session.handle({ type: 'run', speed: 1 });
    while (wall < 2000) {
      wall += 4;
      const fn = pending as (() => void) | null;
      pending = null;
      fn?.();
    }
    expect(ringTft).toBe(0);
    expect(updates[0]).toMatchObject({ full: true, numbers: 38_400 }); // the load's first frame
    // After the picture (~0.8 s of simulated time), each frame carries a digit's box at most.
    const later = updates.filter((u) => u.wall > 1200);
    expect(later.length).toBeGreaterThan(0);
    expect(Math.max(...later.map((u) => u.numbers))).toBeLessThanOrEqual(280);
  });

  it('falls back to frame messages without shared memory, with the same states at the same times', () => {
    const plain = run(false);
    expect(plain.messages.some((m) => m.type === 'frameRing')).toBe(false);
    expect(plain.frames.some((f) => f.type === 'frame' && f.parts.length > 0)).toBe(true);
    expect(plain.led).toEqual(shared().led);
  });
});
