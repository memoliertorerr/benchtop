/**
 * Part visual state over shared memory (BT40). When the page is cross-origin isolated, the
 * simulation worker writes each part's latest visual state into a fixed-size slot of a
 * SharedArrayBuffer and the UI reads the slots that changed on requestAnimationFrame — no
 * message per frame to clone and queue, and a UI that falls behind skips straight to the newest
 * state. Without isolation (or for a state too big for its slot) visual state keeps travelling
 * in `frame` messages; either way a view gets the same VisualState objects.
 *
 * Layout, in 32-bit words then bytes:
 *   [MAGIC, slotCount, slotBytes, 0]            header
 *   [seq, length] × slotCount                   per-slot sequence counter and byte length
 *   slotBytes × slotCount                       per-slot JSON (UTF-8)
 *
 * Torn reads: the writer makes a slot's `seq` odd before it touches the bytes and even again
 * after (a sequence lock). The reader copies the bytes out between two loads of `seq` and keeps
 * the copy only when both loads are the same even number; anything else is retried, and after a
 * few tries left for the next animation frame. `seq` wraps around at 2³² like any Int32 add,
 * which keeps its parity, and readers only compare it for equality. A slot whose state didn't
 * fit is marked empty (a new `seq`, length 0) so a reader never shows an older state after a
 * newer one arrived by message.
 */

import type { VisualState } from '@benchtop/core';

const MAGIC = 0x42_54_46_52; // "BTFR"
const HEADER_WORDS = 4;
/** Room for any state the catalog sends today (an SSD1306 framebuffer is ≈ 2.8 kB of JSON). */
export const SLOT_BYTES = 4096;
/** Reads of one slot per call before leaving it to the next animation frame. */
const READ_TRIES = 4;

const metaWord = (slot: number): number => HEADER_WORDS + 2 * slot;
const dataOffset = (slotCount: number, slotBytes: number, slot: number): number => (HEADER_WORDS + 2 * slotCount) * 4 + slot * slotBytes;

/** A new ring's buffer: shared when the platform allows it (pass `shared = false` to test the layout alone). */
export function createFrameRingBuffer(slotCount: number, slotBytes = SLOT_BYTES, shared = true): SharedArrayBuffer | ArrayBuffer {
  if (!Number.isInteger(slotCount) || slotCount < 0 || slotBytes % 4 !== 0 || slotBytes <= 0) throw new RangeError('bad frame ring size');
  const size = dataOffset(slotCount, slotBytes, slotCount);
  const buffer = shared ? new SharedArrayBuffer(size) : new ArrayBuffer(size);
  const words = new Int32Array(buffer, 0, HEADER_WORDS);
  words[0] = MAGIC;
  words[1] = slotCount;
  words[2] = slotBytes;
  return buffer;
}

function checkLayout(buffer: SharedArrayBuffer | ArrayBuffer, parts: readonly string[]): { words: Int32Array; slotBytes: number } {
  if (buffer.byteLength < HEADER_WORDS * 4) throw new RangeError('frame ring buffer too small');
  const words = new Int32Array(buffer);
  const slotBytes = words[2];
  if (words[0] !== MAGIC || words[1] !== parts.length || slotBytes <= 0 || buffer.byteLength < dataOffset(parts.length, slotBytes, parts.length)) {
    throw new RangeError('not a frame ring for these parts');
  }
  return { words, slotBytes };
}

/** The worker's side: one slot per part, in `parts` order. */
export class FrameRingWriter {
  private readonly words: Int32Array;
  private readonly bytes: Uint8Array;
  private readonly slotBytes: number;
  private readonly slots: Map<string, number>;
  private readonly scratch: Uint8Array;
  private readonly encoder = new TextEncoder();

  constructor(buffer: SharedArrayBuffer | ArrayBuffer, parts: readonly string[]) {
    const layout = checkLayout(buffer, parts);
    this.words = layout.words;
    this.slotBytes = layout.slotBytes;
    this.bytes = new Uint8Array(buffer);
    this.slots = new Map(parts.map((id, i) => [id, i]));
    this.scratch = new Uint8Array(this.slotBytes);
  }

  /**
   * Publishes a part's state. False when it has no slot or doesn't fit (or holds a number JSON
   * can't carry): send it by message instead — the slot is then marked empty.
   */
  write(part: string, visual: VisualState): boolean {
    const slot = this.slots.get(part);
    if (slot === undefined) return false;
    const json = JSON.stringify(visual);
    // VisualState has no null: one in the JSON is a NaN or ±Infinity that would arrive changed.
    const { read, written } = json.includes('null') ? { read: -1, written: 0 } : this.encoder.encodeInto(json, this.scratch);
    const fits = read === json.length;
    const meta = metaWord(slot);
    Atomics.add(this.words, meta, 1); // odd: being written
    if (fits) this.bytes.set(this.scratch.subarray(0, written), dataOffset(this.words[1], this.slotBytes, slot));
    Atomics.store(this.words, meta + 1, fits ? written : 0);
    Atomics.add(this.words, meta, 1); // even: stable
    return fits;
  }
}

/** The UI's side: the states that changed since the last read. */
export class FrameRingReader {
  private readonly words: Int32Array;
  private readonly bytes: Uint8Array;
  private readonly slotBytes: number;
  private readonly parts: readonly string[];
  /** The `seq` each slot had when last read (0: never written). */
  private readonly seen: Int32Array;
  private readonly scratch: Uint8Array;
  private readonly decoder = new TextDecoder();

  constructor(buffer: SharedArrayBuffer | ArrayBuffer, parts: readonly string[]) {
    const layout = checkLayout(buffer, parts);
    this.words = layout.words;
    this.slotBytes = layout.slotBytes;
    this.bytes = new Uint8Array(buffer);
    this.parts = [...parts];
    this.seen = new Int32Array(parts.length);
    this.scratch = new Uint8Array(this.slotBytes);
  }

  /** The newest state of a slot if it changed since the last read; undefined if not, or not readable yet. */
  read(slot: number): VisualState | undefined {
    if (slot < 0 || slot >= this.parts.length) return undefined;
    const meta = metaWord(slot);
    for (let attempt = 0; attempt < READ_TRIES; attempt++) {
      const before = Atomics.load(this.words, meta);
      if (before === this.seen[slot]) return undefined;
      if ((before & 1) !== 0) continue;
      const length = Atomics.load(this.words, meta + 1);
      if (length < 0 || length > this.slotBytes) continue;
      this.copy(slot, length);
      if (Atomics.load(this.words, meta) !== before) continue; // torn: written meanwhile
      this.seen[slot] = before;
      if (length === 0) return undefined;
      try {
        return JSON.parse(this.decoder.decode(this.scratch.subarray(0, length))) as VisualState;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** Every part whose state changed since the last drain, with that state. */
  drain(): [string, VisualState][] {
    const changed: [string, VisualState][] = [];
    for (let slot = 0; slot < this.parts.length; slot++) {
      const visual = this.read(slot);
      if (visual !== undefined) changed.push([this.parts[slot], visual]);
    }
    return changed;
  }

  /** Copies a slot's bytes out of shared memory (a hook the torn-read test interleaves a write into). */
  protected copy(slot: number, length: number): void {
    const at = dataOffset(this.parts.length, this.slotBytes, slot);
    this.scratch.set(this.bytes.subarray(at, at + length));
  }
}
