/**
 * Recording a test in the worker (BT50). "Record test" resets the bench and starts one of these;
 * every input the UI sends (button presses, knob and slider values, keypad keys) and every text
 * typed into a serial monitor is logged with the bench's simulated time — exact to the
 * nanosecond, so the CLI replays it at the same instants. BT156: each board's EEPROM or flash
 * data as the recording starts (a reset keeps it) goes with it, so the replay starts from it. BT144: so is every file the Inspector
 * writes or removes on a card or a USB drive, and (BT146) the MIDI and lock keys it sends a
 * board's USB device. Microphone samples are not recorded (a
 * stream, not a step). Stop ends the recording on the next whole millisecond and proposes
 * expectations from what the bench shows then: the serial lines each board printed (by when they
 * had arrived), the LEDs lit, every non-blank LCD row, each servo's angle (±2°). The UI turns it
 * into a `.bench.json` spec (editor/test-spec.ts).
 */

import { type Nanos, NS_PER_MS, type PartInput, type ProjectDoc, type UsbLocks, type VisualState } from '@benchtop/core';
import { base64Encode, parseCardFiles, utf8Text } from '@benchtop/parts';
import type { MemorySector, RecordedSector, RecordedStep, RecordedTest } from './protocol.ts';

/** Serial lines proposed per board (the most recent distinct ones). */
export const MAX_PROPOSED_LINES = 8;
/** Steps one recording keeps; inputs past it are dropped and the result says so. */
export const MAX_RECORDED_STEPS = 10_000;
/** BT144: bytes one recorded file write may hold — the CLI's MAX_FILE_STEP (a test checks they match). */
export const MAX_RECORDED_FILE = 256 * 1024;
/** BT156: bytes of a board's data (trailing erased bytes trimmed) a recording keeps; more → not kept. */
export const MAX_RECORDED_MEMORY = 256 * 1024;
/** Serial text kept per board for proposals. */
const MAX_SERIAL_TEXT = 256 * 1024;

const LCD_COLS: Readonly<Record<string, number>> = { lcd1602: 16, 'lcd1602-i2c': 16, lcd2004: 20, 'lcd2004-i2c': 20 };

/** Whether two card `files` props put the same files on a card (paths match case-insensitively, as FAT's). */
function sameFiles(a: string, b: string): boolean {
  const files = (text: string): Map<string, string> => new Map(parseCardFiles(text).files.map(([path, bytes]) => [path.toUpperCase(), base64Encode(bytes)]));
  const x = files(a);
  const y = files(b);
  return x.size === y.size && [...x].every(([path, bytes]) => y.get(path) === bytes);
}

/** A time as a spec writes it: whole ms or µs when exact, else ns. */
export function timeText(ns: Nanos): string {
  if (ns % NS_PER_MS === 0) return `${ns / NS_PER_MS}ms`;
  if (ns % 1000 === 0) return `${ns / 1000}us`;
  return `${ns}ns`;
}

/** Text inside an expectation's double quotes: \ and " escaped, newlines as \n. */
export function quoted(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** BT156: a sector's bytes without their trailing erased (0xFF) bytes. */
export function trimErased(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0xff) end--;
  return bytes.subarray(0, end);
}

/** BT156: a board's data sectors as a recording keeps them, or null when they hold more than MAX_RECORDED_MEMORY. */
export function recordedSectors(sectors: readonly MemorySector[]): RecordedSector[] | null {
  const out: RecordedSector[] = [];
  let total = 0;
  for (const sector of sectors) {
    const bytes = trimErased(sector.bytes);
    if (bytes.length === 0) continue;
    total += bytes.length;
    if (total > MAX_RECORDED_MEMORY) return null;
    out.push({ offset: sector.offset, base64: base64Encode(bytes) });
  }
  return out;
}

/** BT144: a card's files when a recording starts: its `files` prop value, or null when they don't fit one. */
export interface CardAtStart {
  part: string;
  files: string | null;
}

export class TestRecording {
  private readonly steps: RecordedStep[] = [];
  private dropped = 0;
  private droppedFiles = 0;
  /** Per board: text received so far, and each complete line with the time its newline arrived. */
  private readonly serial = new Map<string, { text: string; lines: { line: string; at: Nanos }[]; decoder: TextDecoder }>();

  /** Each microSD card's files as the recording started (a bench reset keeps them). */
  private readonly cards: readonly CardAtStart[];
  /** BT156: each board's data sectors as the recording started (a bench reset keeps them). */
  private readonly memory: Readonly<Record<string, readonly MemorySector[]>>;

  constructor(cards: readonly CardAtStart[] = [], memory: Readonly<Record<string, readonly MemorySector[]>> = {}) {
    this.cards = cards;
    this.memory = memory;
  }

  input(at: Nanos, part: string, event: PartInput): void {
    if (this.full()) return;
    this.steps.push({ at, part, input: { ...event } });
  }

  serialSend(at: Nanos, board: string, bytes: Uint8Array): void {
    if (this.full()) return;
    this.steps.push({ at, board, serial: new TextDecoder().decode(bytes) });
  }

  /** BT144: a file the Inspector wrote: text when the bytes are UTF-8, else base64; too big → not kept. */
  fileWrite(at: Nanos, part: string, path: string, bytes: Uint8Array): void {
    if (bytes.length > MAX_RECORDED_FILE) {
      this.droppedFiles++;
      return;
    }
    if (this.full()) return;
    const text = utf8Text(bytes);
    this.steps.push(text === null ? { at, part, write: path, base64: base64Encode(bytes) } : { at, part, write: path, text });
  }

  /** BT144: a file or directory the Inspector removed. */
  fileRemove(at: Nanos, part: string, path: string): void {
    if (this.full()) return;
    this.steps.push({ at, part, remove: path });
  }

  /** BT146: MIDI the Inspector sent a board's USB device, as hex bytes. */
  usbMidi(at: Nanos, board: string, bytes: Uint8Array): void {
    if (this.full()) return;
    this.steps.push({ at, board, midi: Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') });
  }

  /** BT146: the lock keys the Inspector set on a board's USB host. */
  usbLocks(at: Nanos, board: string, locks: UsbLocks): void {
    if (this.full()) return;
    const on: ('num' | 'caps' | 'scroll')[] = [];
    if (locks.num) on.push('num');
    if (locks.caps) on.push('caps');
    if (locks.scroll) on.push('scroll');
    this.steps.push({ at, board, locks: on });
  }

  /** Bytes a board printed, at the bench time they were flushed. */
  serialOut(at: Nanos, board: string, bytes: Uint8Array): void {
    let s = this.serial.get(board);
    if (s === undefined) this.serial.set(board, (s = { text: '', lines: [], decoder: new TextDecoder() }));
    if (s.text.length >= MAX_SERIAL_TEXT) return;
    s.text += s.decoder.decode(bytes, { stream: true });
    for (let nl = s.text.indexOf('\n'); nl >= 0; nl = s.text.indexOf('\n')) {
      const line = s.text.slice(0, nl).replace(/\r$/, '');
      s.text = s.text.slice(nl + 1);
      s.lines.push({ line, at });
    }
  }

  /**
   * The recording ended at `end` (a whole millisecond): its steps and the expectations that hold
   * then. `latest` is each part's latest visual state; `boards` the board part ids.
   */
  finish(end: Nanos, doc: ProjectDoc, latest: ReadonlyMap<string, VisualState>, boards: readonly string[]): RecordedTest {
    const proposals: string[] = [];
    const at = timeText(end);
    for (const board of boards) {
      const prefix = boards.length === 1 ? 'serial' : `serial[${board}]`;
      const lines = this.serial.get(board)?.lines ?? [];
      // The most recent distinct non-blank lines, each by the (whole ms after the) first time it arrived.
      const first = new Map<string, Nanos>();
      for (const { line, at: t } of lines) if (line.trim() !== '' && !first.has(line)) first.set(line, t);
      const recent: string[] = [];
      for (let i = lines.length - 1; i >= 0 && recent.length < MAX_PROPOSED_LINES; i--) {
        const line = lines[i].line;
        if (line.trim() !== '' && !recent.includes(line)) recent.push(line);
      }
      for (const line of recent.reverse()) {
        const by = Math.min(end, Math.ceil((first.get(line) as Nanos) / NS_PER_MS) * NS_PER_MS);
        proposals.push(`${prefix} contains ${quoted(line)} by ${timeText(by)}`);
      }
    }
    for (const part of doc.parts) {
      const visual = latest.get(part.id);
      if (part.type === 'led') {
        if (typeof visual?.brightness === 'number' && visual.brightness >= 0.3) proposals.push(`led ${part.id} is lit at ${at}`);
      } else if (part.type === 'servo') {
        if (typeof visual?.angle === 'number') proposals.push(`servo ${part.id} angle is ${Math.round(visual.angle)} ±2 at ${at}`);
      } else if (Object.hasOwn(LCD_COLS, part.type) && visual?.displayOn === true && Array.isArray(visual.characters)) {
        const cols = LCD_COLS[part.type];
        const chars = visual.characters as number[];
        for (let row = 0; row * cols < chars.length; row++) {
          const text = String.fromCharCode(...chars.slice(row * cols, (row + 1) * cols)).trimEnd();
          // Printable ASCII only: CGRAM glyphs (codes 0–7) don't survive a text expectation.
          if (text !== '' && /^[\x20-\x7e]*$/.test(text)) proposals.push(`lcd ${part.id} row ${row} is ${quoted(text)} at ${at}`);
        }
      }
    }
    const cards: Record<string, string> = {};
    const cardsNotKept: string[] = [];
    for (const card of this.cards) {
      const part = doc.parts.find((p) => p.id === card.part);
      if (part === undefined) continue;
      if (card.files === null) cardsNotKept.push(card.part);
      else if (!sameFiles(card.files, typeof part.props.files === 'string' ? part.props.files : '')) cards[card.part] = card.files;
    }
    const memory: Record<string, RecordedSector[]> = {};
    const memoryNotKept: string[] = [];
    for (const board of boards) {
      const sectors = this.memory[board];
      if (sectors === undefined) continue;
      const kept = recordedSectors(sectors);
      if (kept === null) memoryNotKept.push(board);
      else if (kept.length > 0) memory[board] = kept;
    }
    return { durationNs: end, steps: this.steps, proposals, dropped: this.dropped, droppedFiles: this.droppedFiles, cards, cardsNotKept, memory, memoryNotKept };
  }

  private full(): boolean {
    if (this.steps.length < MAX_RECORDED_STEPS) return false;
    this.dropped++;
    return true;
  }
}
