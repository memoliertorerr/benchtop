/**
 * Live simulation sessions for the MCP server (BT69): a bench an assistant opens, runs in steps,
 * pokes (inputs, serial) and reads (serial since the last read, part states, pin levels,
 * watched pins' edges, frequency and duty, new problems) between steps. `Sessions` holds at most
 * `maxSessions` of them; opening one more closes the one used longest ago.
 *
 * A run goes in 10 ms simulated slices, so it can stop at a serial text and at the call's
 * wall-clock budget; a watched pin's probe is drained every slice (its ring holds far more edges
 * than 10 ms of anything a sketch toggles).
 *
 * BT79: `update` gives a session a new project document while it lives — the bench is rebuilt
 * with carry-over (time, boards that keep running, unchanged parts' state), as the app does.
 */

import { type Bench, type BenchRunResult, type DebugTables, discardCarry, type FirmwareImage, lineTableFromElf, type NetState, parseElf32, type Problem, type ProjectDoc, SymbolTable, type VisualState } from '@benchtop/core';
import { type BenchRoms, buildBench, resolvePin, UsageError } from '../load.ts';

/** Simulated time per run slice. */
export const SLICE_NS = 10_000_000;

export interface PinWindow {
  /** Level changes seen in the window. */
  edges: number;
  /** From the rising edges (at least two). */
  frequencyHz?: number;
  /** Time high over the window, %. */
  dutyPct: number;
  /** Level at the window's end: 0, 1, z (floating) or x (a short). */
  level: string;
  /** Edges the probe's ring dropped (the measurement is then unreliable). */
  lost?: number;
}

interface Watch {
  key: string;
  probe: number;
  cursor: number;
  from: number;
  lastTime: number;
  lastLevel: number;
  highNs: number;
  edges: number;
  rises: number;
  firstRise: number;
  lastRise: number;
  lost: number;
}

export const levelText = (state: NetState | undefined): string => (state === undefined ? 'z' : state.conflict ? 'x' : state.level === null ? 'z' : String(state.level));

export interface SessionInit {
  id: string;
  label: string;
  doc: ProjectDoc;
  boards: string[];
  images: Readonly<Record<string, FirmwareImage>>;
  roms: BenchRoms;
  /** "part:pin" entries to measure on every run. */
  watch: readonly string[];
  /** Serial characters kept per board between reads (the newest). */
  serialChars: number;
  /** BT74: debug tables for boards whose image isn't an ELF (from an .elf or .syms.tsv beside it). */
  tables?: Readonly<Record<string, DebugTables>>;
}

/** What `Session.update` did to the boards and watched pins. */
export interface SessionUpdate {
  /** Boards still running what they ran. */
  kept: string[];
  /** Boards started afresh (new, re-flashed or of another kind). */
  started: string[];
  removed: string[];
  /** Watched pins that no longer exist (no longer measured). */
  unwatched: string[];
}

export class Session {
  readonly id: string;
  readonly label: string;
  doc: ProjectDoc;
  boards: string[];
  bench: Bench;
  lastUsed = 0;
  private readonly serialChars: number;
  /** Serial text per board since the last read, and characters dropped from its front. */
  private readonly pending: Record<string, string> = {};
  private readonly dropped: Record<string, number> = {};
  /** Every part's latest visual state. */
  readonly latest = new Map<string, VisualState>();
  private readonly watches: Watch[] = [];
  private readonly reported = new Set<string>();
  /** BT70: symbols and source lines per board whose firmware is an ELF. */
  readonly tables = new Map<string, DebugTables>();

  constructor(init: SessionInit) {
    this.id = init.id;
    this.label = init.label;
    this.doc = init.doc;
    this.boards = init.boards;
    this.serialChars = init.serialChars;
    this.bench = buildBench(init.doc, init.images, init.roms).bench;
    for (const board of init.boards) {
      this.pending[board] = '';
      this.dropped[board] = 0;
    }
    this.listenSerial();
    for (const key of init.watch) this.addWatch(key);
    this.addTables(init.images, init.tables ?? {});
    this.collect();
  }

  private listenSerial(): void {
    for (const board of this.boards) {
      const decoder = new TextDecoder();
      this.bench.onSerial(board, (bytes) => this.append(board, decoder.decode(bytes, { stream: true })));
    }
  }

  private addTables(images: Readonly<Record<string, FirmwareImage>>, tables: Readonly<Record<string, DebugTables>>): void {
    for (const [board, found] of Object.entries(tables)) this.tables.set(board, found);
    for (const [board, image] of Object.entries(images)) {
      if (image.format !== 'elf') continue;
      try {
        const elf = parseElf32(image.bytes);
        this.tables.set(board, { symbols: SymbolTable.fromElf(elf), lines: lineTableFromElf(elf) ?? null });
      } catch {
        // an ELF the MCU accepted but the debug tables can't read: addresses only
      }
    }
  }

  /**
   * BT79: a new project document for the live bench. It is rebuilt with carry-over: time goes on,
   * a board keeps running what it ran unless it is in `restart` (its new firmware is in
   * `images`) or new, unchanged parts keep their state, watched pins are measured on (those that
   * no longer exist are dropped). Serial text not yet read stays. If the rebuild fails, the
   * session can't go on: the caller closes it.
   */
  update(next: { doc: ProjectDoc; boards: string[]; images: Readonly<Record<string, FirmwareImage>>; roms: SessionInit['roms']; restart: readonly string[]; tables?: Readonly<Record<string, DebugTables>> }): SessionUpdate {
    const carry = this.bench.carry(); // flushes serial output to this session first
    let bench: Bench;
    try {
      bench = buildBench(next.doc, next.images, next.roms, { carry, restart: next.restart }).bench;
    } catch (error) {
      discardCarry(carry);
      throw error;
    }
    const removed = this.boards.filter((b) => !next.boards.includes(b));
    const kept = next.boards.filter((b) => bench.carriedBoard(b));
    const started = next.boards.filter((b) => !bench.carriedBoard(b));
    for (const board of removed) {
      delete this.pending[board];
      delete this.dropped[board];
    }
    for (const board of [...removed, ...started]) this.tables.delete(board);
    for (const board of started) {
      this.pending[board] ??= '';
      this.dropped[board] ??= 0;
    }
    this.bench = bench;
    this.doc = next.doc;
    this.boards = next.boards;
    this.listenSerial();
    this.addTables(Object.fromEntries(Object.entries(next.images).filter(([b]) => started.includes(b))), next.tables ?? {});
    const unwatched: string[] = [];
    const watched = this.watches.splice(0).map((w) => w.key);
    for (const key of watched) {
      try {
        this.addWatch(key);
      } catch {
        unwatched.push(key);
      }
    }
    const ids = new Set(next.doc.parts.map((p) => p.id));
    for (const part of [...this.latest.keys()]) if (!ids.has(part)) this.latest.delete(part);
    this.collect();
    return { kept, started, removed, unwatched };
  }

  /** Where a board's PC is: the address, the function and offset, the source line (as far as its tables tell). */
  location(board: string, pc: number): { pc: string; function?: string; file?: string; line?: number } {
    const tables = this.tables.get(board);
    const fn = tables?.symbols?.functionAt(pc);
    const line = tables?.lines?.addressToLine(pc);
    return {
      pc: `0x${pc.toString(16).padStart(4, '0')}`,
      ...(fn === undefined ? {} : { function: fn.offset === 0 ? fn.name : `${fn.name}+0x${fn.offset.toString(16)}` }),
      ...(line === undefined ? {} : { file: line.file.slice(Math.max(line.file.lastIndexOf('/'), line.file.lastIndexOf('\\')) + 1), line: line.line }),
    };
  }

  private append(board: string, text: string): void {
    const next = this.pending[board] + text;
    const over = next.length - this.serialChars;
    if (over > 0) {
      this.pending[board] = next.slice(over);
      this.dropped[board] += over;
    } else this.pending[board] = next;
  }

  /** "part:pin" → the part id and the pin as its definition spells it. */
  pinRef(key: string): { part: string; pin: string } {
    const i = key.lastIndexOf(':');
    const part = i > 0 ? key.slice(0, i) : '';
    const asked = key.slice(i + 1);
    const pin = part === '' ? undefined : resolvePin(this.doc, part, asked);
    if (pin === undefined) throw new UsageError(`no pin "${key}" — write "<part id>:<pin name>", e.g. "uno:13" or "led1:A"`);
    return { part, pin };
  }

  addWatch(key: string): void {
    if (this.watches.some((w) => w.key === key)) return;
    const ref = this.pinRef(key);
    const probe = this.bench.addProbe(ref);
    if (probe < 0) throw new UsageError(`too many watched pins (the bench probes at most a few dozen)`);
    const read = this.bench.readProbe(probe, 0);
    this.watches.push({ key, probe, cursor: read === undefined ? 0 : read.from + read.times.length, from: 0, lastTime: 0, lastLevel: 2, highNs: 0, edges: 0, rises: 0, firstRise: -1, lastRise: -1, lost: 0 });
  }

  private openWindows(): void {
    const now = this.bench.now();
    for (const w of this.watches) {
      const ref = this.pinRef(w.key);
      const state = this.bench.pinState(ref.part, ref.pin);
      w.from = now;
      w.lastTime = now;
      w.lastLevel = state === undefined || state.conflict || state.level === null ? 2 : state.level;
      w.highNs = 0;
      w.edges = 0;
      w.rises = 0;
      w.firstRise = -1;
      w.lastRise = -1;
      w.lost = 0;
    }
  }

  private drain(): void {
    for (const w of this.watches) {
      const read = this.bench.readProbe(w.probe, w.cursor);
      if (read === undefined) continue;
      w.lost += read.lost;
      w.cursor = read.from + read.times.length;
      for (let i = 0; i < read.times.length; i++) {
        const time = read.times[i];
        const level = read.levels[i];
        if (w.lastLevel === 1 && time > w.lastTime) w.highNs += time - Math.max(w.lastTime, w.from);
        if (level !== w.lastLevel) w.edges++;
        if (level === 1 && w.lastLevel !== 1) {
          if (w.firstRise < 0) w.firstRise = time;
          w.lastRise = time;
          w.rises++;
        }
        w.lastTime = time;
        w.lastLevel = level;
      }
    }
  }

  private closeWindows(): Record<string, PinWindow> {
    const now = this.bench.now();
    const out: Record<string, PinWindow> = {};
    for (const w of this.watches) {
      if (w.lastLevel === 1 && now > w.lastTime) w.highNs += now - w.lastTime;
      w.lastTime = now;
      const span = now - w.from;
      const ref = this.pinRef(w.key);
      out[w.key] = {
        edges: w.edges,
        ...(w.rises >= 2 ? { frequencyHz: Math.round((((w.rises - 1) * 1e9) / (w.lastRise - w.firstRise)) * 1000) / 1000 } : {}),
        dutyPct: span > 0 ? Math.round(((100 * w.highNs) / span) * 100) / 100 : 0,
        level: levelText(this.bench.pinState(ref.part, ref.pin)),
        ...(w.lost > 0 ? { lost: w.lost } : {}),
      };
    }
    return out;
  }

  collect(): void {
    for (const [part, visual] of this.bench.collectFrame().parts) this.latest.set(part, structuredClone(visual));
  }

  /**
   * Runs up to `durationNs` more, stopping early when `until` appears on a board's serial (since
   * this run began) or when `deadline()` says the wall-clock budget is spent.
   */
  run(durationNs: number, until: { text: string; board: string } | undefined, deadline: () => boolean): { stoppedBy: 'duration' | 'serial' | 'wall' | 'breakpoint'; breakpoint?: string; watched: Record<string, PinWindow> } {
    const end = this.bench.now() + durationNs;
    const seenBefore = until === undefined ? 0 : this.pending[until.board].length;
    const droppedBefore = until === undefined ? 0 : this.dropped[until.board];
    this.openWindows();
    let stoppedBy: 'duration' | 'serial' | 'wall' | 'breakpoint' = 'duration';
    let breakpoint: string | undefined;
    while (this.bench.now() < end) {
      const result: BenchRunResult = this.bench.runUntil(Math.min(end, this.bench.now() + SLICE_NS));
      this.drain();
      if (result.reason === 'breakpoint') {
        stoppedBy = 'breakpoint';
        breakpoint = result.board;
        break;
      }
      if (until !== undefined) {
        const since = this.pending[until.board].slice(Math.max(0, seenBefore - (this.dropped[until.board] - droppedBefore)));
        if (since.includes(until.text)) {
          stoppedBy = 'serial';
          break;
        }
      }
      if (this.bench.now() < end && deadline()) {
        stoppedBy = 'wall';
        break;
      }
    }
    this.collect();
    return { stoppedBy, ...(breakpoint === undefined ? {} : { breakpoint }), watched: this.closeWindows() };
  }

  /** Serial text per board since the last read (and how much was dropped from its front). */
  takeSerial(): { serial: Record<string, string>; dropped?: Record<string, number> } {
    const serial: Record<string, string> = {};
    const dropped: Record<string, number> = {};
    for (const board of this.boards) {
      serial[board] = this.pending[board];
      if (this.dropped[board] > 0) dropped[board] = this.dropped[board];
      this.pending[board] = '';
      this.dropped[board] = 0;
    }
    return Object.keys(dropped).length > 0 ? { serial, dropped } : { serial };
  }

  /** Problems not reported by an earlier call. */
  newProblems(): Problem[] {
    const fresh: Problem[] = [];
    for (const p of this.bench.problems()) {
      const key = `${p.code}|${p.parts.join(',')}|${p.message}`;
      if (this.reported.has(key)) continue;
      this.reported.add(key);
      fresh.push(p);
    }
    return fresh;
  }

  reset(): void {
    this.bench.reset();
    for (const board of this.boards) {
      this.pending[board] = '';
      this.dropped[board] = 0;
    }
    this.reported.clear();
    this.latest.clear();
    this.collect();
  }

  dispose(): void {
    this.bench.dispose();
  }
}

export class Sessions {
  private readonly open = new Map<string, Session>();
  private next = 1;
  private clock = 0;
  readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  /** A new session; the one used longest ago closes first when the limit is reached. */
  add(init: Omit<SessionInit, 'id'>): { session: Session; closed?: string } {
    let closed: string | undefined;
    if (this.open.size >= this.max) {
      const oldest = [...this.open.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      oldest.dispose();
      this.open.delete(oldest.id);
      closed = oldest.id;
    }
    const session = new Session({ ...init, id: `s${this.next++}` });
    session.lastUsed = ++this.clock;
    this.open.set(session.id, session);
    return closed === undefined ? { session } : { session, closed };
  }

  get(id: string): Session {
    const session = this.open.get(id);
    if (session === undefined) throw new UsageError(`no open session "${id}" — sim_list shows them; sim_open starts one`);
    session.lastUsed = ++this.clock;
    return session;
  }

  close(id: string): void {
    this.get(id).dispose();
    this.open.delete(id);
  }

  list(): Session[] {
    return [...this.open.values()];
  }

  closeAll(): void {
    for (const session of this.open.values()) session.dispose();
    this.open.clear();
  }
}
