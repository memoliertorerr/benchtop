/**
 * Recording a test in the worker (BT50). "Record test" resets the bench and starts one of these;
 * every input the UI sends (button presses, knob and slider values, keypad keys) and every text
 * typed into a serial monitor is logged with the bench's simulated time — exact to the
 * nanosecond, so the CLI replays it at the same instants. Microphone samples are not recorded (a
 * stream, not a step). Stop ends the recording on the next whole millisecond and proposes
 * expectations from what the bench shows then: the serial lines each board printed (by when they
 * had arrived), the LEDs lit, every non-blank LCD row, each servo's angle (±2°). The UI turns it
 * into a `.bench.json` spec (editor/test-spec.ts).
 */

import { type Nanos, NS_PER_MS, type PartInput, type ProjectDoc, type VisualState } from '@benchtop/core';
import type { RecordedStep, RecordedTest } from './protocol.ts';

/** Serial lines proposed per board (the most recent distinct ones). */
export const MAX_PROPOSED_LINES = 8;
/** Steps one recording keeps; inputs past it are dropped and the result says so. */
export const MAX_RECORDED_STEPS = 10_000;
/** Serial text kept per board for proposals. */
const MAX_SERIAL_TEXT = 256 * 1024;

const LCD_COLS: Readonly<Record<string, number>> = { lcd1602: 16, 'lcd1602-i2c': 16, lcd2004: 20, 'lcd2004-i2c': 20 };

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

export class TestRecording {
  private readonly steps: RecordedStep[] = [];
  private dropped = 0;
  /** Per board: text received so far, and each complete line with the time its newline arrived. */
  private readonly serial = new Map<string, { text: string; lines: { line: string; at: Nanos }[]; decoder: TextDecoder }>();

  input(at: Nanos, part: string, event: PartInput): void {
    if (this.full()) return;
    this.steps.push({ at, part, input: { ...event } });
  }

  serialSend(at: Nanos, board: string, bytes: Uint8Array): void {
    if (this.full()) return;
    this.steps.push({ at, board, serial: new TextDecoder().decode(bytes) });
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
    return { durationNs: end, steps: this.steps, proposals, dropped: this.dropped };
  }

  private full(): boolean {
    if (this.steps.length < MAX_RECORDED_STEPS) return false;
    this.dropped++;
    return true;
  }
}
