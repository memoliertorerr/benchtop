/**
 * The simulation behind the worker boundary: handles ToSim messages, owns the Bench, paces it
 * against the wall clock and posts frames, serial bytes and problems. DOM-free and free of
 * Worker globals — the worker (worker.ts) and the tests inject `post`, `now` and `schedule` — so
 * the whole loop is tested in Node with a manual clock.
 *
 * A tick runs the bench toward the pacer's target in 1 ms slices until the target or an 8 ms
 * wall budget, posts the serial bytes that arrived (one message per board per tick), and posts
 * a frame when ≥ 16 ms of wall time passed since the last one. Pause, step and reset always
 * post a frame. Anything the bench throws becomes an `error` message and pauses the run.
 *
 * Debugger (BT24): each board's symbols and line table are parsed here once per firmware (a
 * big ELF parsed on the UI thread would jank it) and posted as transferable arrays. Breakpoints
 * arrive as the user typed them and are resolved and armed at every load, before the first
 * instruction runs. A breakpoint stop ends the
 * run and posts `debugStopped`; so do pause, steps and a load or reset while paused. Step over
 * a call runs at max speed until the call returns (BT24's stepping rules), then restores the
 * speed.
 */

import {
  assembleBench,
  beginStepOver,
  type Bench,
  endStepOver,
  type FirmwareImage,
  type LineTable,
  lineTableFromElf,
  type LineTableData,
  type Mcu,
  type MemorySpace,
  NS_PER_MS,
  type PartInput,
  parseElf32,
  pcAndSp,
  type Problem,
  type ProjectDoc,
  RealtimePacer,
  resolveBreakpoint,
  stepOverStopped,
  type StepOverPlan,
  SymbolTable,
  type SymbolTableData,
  validateProject,
  type VisualState,
} from '@benchtop/core';
import { analogSpecFor } from '@benchtop/parts';
import { createBenchEnv, type RecordingEnv } from './env.ts';
import { createFrameRingBuffer, FrameRingWriter } from './frame-ring.ts';
import { type DebugStopReason, type FromSim, type ProbeChunk, PROTOCOL_VERSION, type ToSim } from './protocol.ts';
import { TestRecording } from './recording.ts';

/** Most edges one frame carries per probe (the newest; the rest are counted as lost). */
export const MAX_FRAME_EDGES = 65_536;
/** Largest debugReadMemory answered, and most breakpoints per board. */
const MAX_MEMORY_READ = 4096;
const MAX_BREAKPOINTS = 256;

interface SessionProbe {
  pin: { part: string; pin: string };
  /** The bench's probe id, or −1 when the pin doesn't exist on this bench. */
  id: number;
  since: number;
  restart: boolean;
  peripheral: boolean;
}

export interface SimSessionDeps {
  /** Posts a message to the UI; `transfer` lists buffers to move instead of copy. */
  post(message: FromSim, transfer: ArrayBuffer[]): void;
  /** Wall clock, ms. */
  now(): number;
  /** Runs `fn` soon, after pending messages (a macrotask). */
  schedule(fn: () => void): void;
  /** The ESP32 ROM ELF, when the worker has it (BT34); undefined: ESP32 boards report it missing. */
  esp32Rom?(): Uint8Array | undefined;
  /**
   * The UI can read shared memory (the worker is cross-origin isolated): visual state goes
   * through a frame ring (BT40) instead of `frame` messages.
   */
  sharedMemory?: boolean;
}

/** Wall time one tick may spend running the bench. */
export const TICK_BUDGET_MS = 8;
/** Wall time between frames while running. */
export const FRAME_INTERVAL_MS = 16;
/** Simulated time per slice between budget checks. */
const SLICE_NS = NS_PER_MS;
/** Most simulated time one tick runs, even when the wall clock doesn't move (tests, max speed). */
const MAX_TICK_NS = 250 * NS_PER_MS;

const SERIAL_TX: PartInput = Object.freeze({ kind: 'key', key: 'serial-tx', down: true });
const SERIAL_RX: PartInput = Object.freeze({ kind: 'key', key: 'serial-rx', down: true });
/** Reused for every microphone sample (the model reads it synchronously). */
const MIC_SAMPLE: { kind: 'value'; value: number } = { kind: 'value', value: 0 };

export class SimSession {
  private readonly deps: SimSessionDeps;
  private bench: Bench | null = null;
  private env: RecordingEnv = createBenchEnv();
  private readonly pacer = new RealtimePacer(1);
  private running = false;
  private tickQueued = false;
  private lastFrameWall = Number.NEGATIVE_INFINITY;
  private readonly serial = new Map<string, Uint8Array[]>();
  private readonly cycleMarks = new Map<string, { cycles: number; wall: number; mhz: number }>();
  private problemsKey = '';
  private readonly probes = new Map<string, SessionProbe>();
  /** The speed of the last `run` (step over runs at max speed, then restores it). */
  private speed = 1;
  /** Breakpoints as the UI typed them, per board. */
  private readonly breakpoints = new Map<string, string[]>();
  /** Per board: the firmware key, and its parsed tables (also what breakpoints resolve against). */
  private readonly debugTables = new Map<string, { key: string; symbols: SymbolTable | null; lines: LineTable | null }>();
  private stepOver: { board: string; plan: StepOverPlan } | null = null;
  /** This bench's frame ring, when visual state goes over shared memory. */
  private ring: FrameRingWriter | null = null;
  /** The loaded project (for a recording's proposals). */
  private doc: ProjectDoc | null = null;
  /** Each part's latest visual state, as frames collected it. */
  private readonly latest = new Map<string, VisualState>();
  /** A test being recorded (BT50). */
  private recording: TestRecording | null = null;

  constructor(deps: SimSessionDeps) {
    this.deps = deps;
  }

  /** Handles one message from the UI. Never throws. */
  handle(message: ToSim): void {
    try {
      this.dispatch(message);
    } catch (error) {
      this.fail(error);
    }
  }

  private dispatch(message: ToSim): void {
    switch (message.type) {
      case 'hello':
        if (message.protocol !== PROTOCOL_VERSION) {
          this.post({ type: 'error', message: `protocol mismatch: ui ${message.protocol}, worker ${PROTOCOL_VERSION}` });
          return;
        }
        this.post({ type: 'ready', protocol: PROTOCOL_VERSION });
        return;
      case 'load':
        this.load(message.doc, message.firmware);
        return;
      case 'setFirmware': {
        const bench = this.requireBench();
        this.abandonStepOver();
        bench.attachFirmware(message.board, message.image);
        this.serial.get(message.board)?.splice(0); // unflushed output of the old firmware
        this.cycleMarks.delete(message.board);
        this.postDebugInfo(message.board, message.image);
        this.applyBreakpoints(message.board);
        this.postFrame();
        if (!this.running) this.postDebugStopped(message.board, 'pause');
        return;
      }
      case 'run':
        if (this.bench === null) throw new Error('nothing loaded');
        this.abandonStepOver();
        this.speed = message.speed;
        this.pacer.setSpeed(message.speed);
        this.pacer.start(this.deps.now());
        this.running = true;
        this.queueTick();
        return;
      case 'pause':
      case 'debugPause':
        this.abandonStepOver();
        this.running = false;
        this.flushSerial();
        this.postFrame();
        this.postDebugStates('pause');
        return;
      case 'debugStep':
        this.stepInstruction(message.board);
        return;
      case 'debugStepOver': {
        const bench = this.requireBench();
        const debug = bench.debugOf(message.board);
        if (debug === undefined) throw new Error(`"${message.board}" has no debugger`);
        this.abandonStepOver();
        if (!debug.instructionAt(pcAndSp(debug).pc).isCall) {
          this.stepInstruction(message.board);
          return;
        }
        const plan = beginStepOver(debug);
        if (plan === null) return;
        this.stepOver = { board: message.board, plan };
        this.pacer.setSpeed(Number.POSITIVE_INFINITY);
        this.pacer.start(this.deps.now());
        this.running = true;
        this.queueTick();
        return;
      }
      case 'debugSetBreakpoints': {
        const specs = Array.isArray(message.specs) ? message.specs.filter((t) => typeof t === 'string' && t.length <= 200).slice(0, MAX_BREAKPOINTS) : [];
        this.breakpoints.set(message.board, specs);
        this.applyBreakpoints(message.board);
        return;
      }
      case 'debugReadMemory':
        this.readMemory(message.board, message.space, message.addr, message.len);
        return;
      case 'reset':
        this.resetBench();
        return;
      case 'recordStart':
        this.resetBench();
        this.recording = new TestRecording();
        return;
      case 'recordStop':
        this.stopRecording();
        return;
      case 'step': {
        const bench = this.requireBench();
        this.abandonStepOver();
        this.running = false;
        const result = bench.runUntil(bench.now() + Math.max(0, message.ns));
        this.flushSerial();
        this.postFrame();
        this.postDebugStates('pause');
        if (result.reason === 'breakpoint') this.postDebugStopped(result.board, 'breakpoint');
        return;
      }
      case 'input': {
        const bench = this.requireBench();
        this.recording?.input(bench.now(), message.part, message.event);
        bench.input(message.part, message.event);
        return;
      }
      case 'audioIn': {
        // Nothing loaded: dropped. The microphone's own queue caps what waits (200 ms).
        const bench = this.bench;
        if (bench === null) return;
        const samples = message.samples;
        for (let i = 0; i < samples.length; i++) {
          MIC_SAMPLE.value = samples[i];
          bench.input(message.part, MIC_SAMPLE);
        }
        return;
      }
      case 'serialSend': {
        const bench = this.requireBench();
        this.recording?.serialSend(bench.now(), message.board, message.bytes);
        bench.sendSerial(message.board, message.bytes);
        bench.input(message.board, SERIAL_RX);
        return;
      }
      case 'addProbe': {
        if (this.probes.has(message.key)) return;
        const probe: SessionProbe = { pin: message.pin, id: -1, since: 0, restart: true, peripheral: false };
        this.probes.set(message.key, probe);
        if (this.bench !== null) probe.id = this.bench.addProbe(message.pin);
        return;
      }
      case 'removeProbe': {
        const probe = this.probes.get(message.key);
        if (probe === undefined) return;
        this.probes.delete(message.key);
        // Pins on one net share the bench's probe: keep it while another key still uses it.
        const shared = [...this.probes.values()].some((p) => p.id === probe.id);
        if (this.bench !== null && probe.id >= 0 && !shared) this.bench.removeProbe(probe.id);
        return;
      }
    }
  }

  private load(doc: unknown, firmware: Record<string, FirmwareImage>): void {
    this.running = false;
    this.stepOver = null; // its breakpoint lived in the old bench's MCU
    this.pacer.setSpeed(this.speed);
    this.bench?.dispose();
    this.bench = null;
    this.recording = null;
    this.latest.clear();
    this.serial.clear();
    this.cycleMarks.clear();
    this.env = createBenchEnv(this.deps.esp32Rom?.());
    // assembleBench resets the bench, which invalidates every part: the first frame carries
    // every view's state and nothing keeps showing what a previous bench left on screen.
    const project = validateProject(doc);
    const bench = assembleBench(project, this.env, firmware, { analogSpecFor });
    for (const board of this.env.mcus.keys()) {
      bench.onSerial(board, (bytes) => {
        this.recording?.serialOut(bench.now(), board, bytes);
        let chunks = this.serial.get(board);
        if (chunks === undefined) this.serial.set(board, (chunks = []));
        chunks.push(bytes);
      });
    }
    this.bench = bench;
    this.doc = project;
    this.ring = null;
    if (this.deps.sharedMemory === true) {
      const parts = project.parts.map((p) => p.id);
      const buffer = createFrameRingBuffer(parts.length) as SharedArrayBuffer;
      this.ring = new FrameRingWriter(buffer, parts);
      this.post({ type: 'frameRing', buffer, parts });
    }
    for (const probe of this.probes.values()) {
      probe.id = bench.addProbe(probe.pin);
      probe.since = 0;
      probe.restart = true;
    }
    const problems = [...bench.problems()];
    this.post({ type: 'loaded', problems });
    // An edit that fixed (or caused) something changes the set: say so like any other change.
    this.postProblems(false);
    this.postFrame();
    for (const board of this.env.mcus.keys()) {
      this.postDebugInfo(board, firmware[board]);
      this.applyBreakpoints(board);
      this.postDebugStopped(board, 'pause');
    }
  }

  /** Bench reset: time 0, every MCU and part; probes and serial restart. Keeps running if it was. */
  private resetBench(): void {
    const bench = this.requireBench();
    this.abandonStepOver();
    this.recording = null;
    bench.reset();
    for (const probe of this.probes.values()) {
      probe.since = 0;
      probe.restart = true;
    }
    this.serial.clear();
    this.cycleMarks.clear();
    this.pacer.start(this.deps.now());
    this.postFrame();
    this.postProblems(true);
    if (!this.running) this.postDebugStates('pause');
  }

  /** Ends a recording on the next whole millisecond (paused there) and posts it. */
  private stopRecording(): void {
    const bench = this.requireBench();
    const recording = this.recording;
    if (recording === null) return;
    this.recording = null;
    this.abandonStepOver();
    this.running = false;
    const end = Math.ceil(bench.now() / NS_PER_MS) * NS_PER_MS;
    if (end > bench.now()) bench.runUntil(end);
    this.flushSerial();
    this.postFrame();
    this.postDebugStates('pause');
    const doc = this.doc as ProjectDoc;
    this.post({ type: 'recorded', test: recording.finish(end, doc, this.latest, [...this.env.mcus.keys()]) });
  }

  // ── Debugger ─────────────────────────────────────────────────────────────────────────────

  /** One instruction on `board`, then the stop report. */
  private stepInstruction(board: string): void {
    const bench = this.requireBench();
    this.abandonStepOver();
    this.running = false;
    const result = bench.debugStep(board);
    this.flushSerial();
    this.postFrame();
    this.postDebugStopped(board, 'step');
    if (result.reason === 'breakpoint' && result.board !== board) this.postDebugStopped(result.board, 'breakpoint');
  }

  /** Called on a breakpoint stop during a run; true when the run should end. */
  private onBreakpoint(board: string): boolean {
    const bench = this.requireBench();
    const active = this.stepOver;
    let reason: DebugStopReason = 'breakpoint';
    if (active !== null && active.board === board) {
      const debug = bench.debugOf(board);
      const outcome = debug === undefined ? 'breakpoint' : stepOverStopped(debug, active.plan);
      if (outcome === 'continue') return false; // the return address, deeper in a recursion
      this.stepOver = null;
      this.pacer.setSpeed(this.speed);
      if (outcome === 'stepped') reason = 'step';
    }
    this.running = false;
    this.flushSerial();
    this.postFrame();
    this.postDebugStopped(board, reason);
    return true;
  }

  /** Drops an unfinished step over: its temporary breakpoint and its max speed. */
  private abandonStepOver(): void {
    const active = this.stepOver;
    if (active === null) return;
    this.stepOver = null;
    this.pacer.setSpeed(this.speed);
    const debug = this.bench?.debugOf(active.board);
    if (debug !== undefined) endStepOver(debug, active.plan);
  }

  /** Makes the board's MCU hold exactly the UI's breakpoints, resolved (plus a step over's own). */
  private applyBreakpoints(board: string): void {
    const debug = this.bench?.debugOf(board);
    if (debug === undefined) return;
    const temporary = this.stepOver?.board === board && this.stepOver.plan.temporary ? this.stepOver.plan.target : -1;
    for (const address of debug.breakpoints()) if (address !== temporary) debug.clearBreakpoint(address);
    const tables = this.debugTables.get(board) ?? { symbols: null, lines: null };
    for (const spec of this.breakpoints.get(board) ?? []) {
      const resolved = resolveBreakpoint(spec, tables);
      if (!resolved.ok) continue; // the UI shows why
      for (const address of resolved.addresses) {
        try {
          debug.setBreakpoint(address);
        } catch {
          // not a valid address for this MCU (the UI shows the address)
        }
      }
    }
  }

  /**
   * Parses a board's symbols and lines once per firmware and posts copies to the UI (the
   * session keeps its own tables to resolve breakpoints against).
   */
  private postDebugInfo(board: string, image: FirmwareImage | undefined): void {
    const key = firmwareKey(image);
    if (this.debugTables.get(board)?.key === key) return;
    let symbols: SymbolTable | null = null;
    let lines: LineTable | null = null;
    let error: string | null = null;
    if (image?.format === 'elf') {
      try {
        const elf = parseElf32(image.bytes);
        symbols = SymbolTable.fromElf(elf);
        lines = lineTableFromElf(elf) ?? null;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    this.debugTables.set(board, { key, symbols, lines });
    const transfer: ArrayBuffer[] = [];
    const copy = <T extends Uint8Array | Uint32Array>(array: T): T => {
      const out = array.slice() as T;
      transfer.push(out.buffer as ArrayBuffer);
      return out;
    };
    let symbolData: SymbolTableData | null = null;
    if (symbols !== null) {
      const d = symbols.data;
      symbolData = { names: d.names, address: copy(d.address), size: copy(d.size), kind: copy(d.kind), space: copy(d.space) };
    }
    let lineData: LineTableData | null = null;
    if (lines !== null) {
      const d = lines.data;
      lineData = {
        files: d.files,
        address: copy(d.address),
        line: copy(d.line),
        file: copy(d.file),
        flags: copy(d.flags),
        seqStart: copy(d.seqStart),
        seqEnd: copy(d.seqEnd),
      };
    }
    this.deps.post({ type: 'debugInfo', board, symbols: symbolData, lines: lineData, error }, transfer);
  }

  private postDebugStopped(board: string, reason: DebugStopReason): void {
    const debug = this.bench?.debugOf(board);
    if (debug === undefined) return;
    const registers = new Uint32Array(debug.registers().length);
    debug.readRegisters(registers);
    this.deps.post({ type: 'debugStopped', board, reason, pc: registers[debug.pcIndex], registers }, [registers.buffer]);
  }

  private postDebugStates(reason: DebugStopReason): void {
    for (const board of this.env.mcus.keys()) this.postDebugStopped(board, reason);
  }

  /** Up to MAX_MEMORY_READ bytes from `addr`, cut short at the end of the space. */
  private readMemory(board: string, space: MemorySpace, addr: number, len: number): void {
    const debug = this.requireBench().debugOf(board);
    if (debug === undefined) throw new Error(`"${board}" has no debugger`);
    let bytes: Uint8Array = new Uint8Array(0);
    if (Number.isInteger(addr) && addr >= 0) {
      for (let n = Math.min(MAX_MEMORY_READ, Math.max(0, Math.floor(len))); n > 0; n = n > 16 ? n - 16 : n - 1) {
        try {
          bytes = debug.readMemory(space, addr, n);
          break;
        } catch {
          // past the end of the space: try fewer bytes
        }
      }
    }
    this.deps.post({ type: 'debugMemory', board, space, addr, bytes }, [bytes.buffer as ArrayBuffer]);
  }

  private queueTick(): void {
    if (this.tickQueued) return;
    this.tickQueued = true;
    this.deps.schedule(this.tick);
  }

  private readonly tick = (): void => {
    this.tickQueued = false;
    const bench = this.bench;
    if (!this.running || bench === null) return;
    try {
      const start = this.deps.now();
      const limit = Math.min(this.pacer.target(start, bench.now()), bench.now() + MAX_TICK_NS);
      while (bench.now() < limit) {
        const result = bench.runUntil(Math.min(limit, bench.now() + SLICE_NS));
        if (result.reason === 'breakpoint' && this.onBreakpoint(result.board)) return;
        if (this.deps.now() - start >= TICK_BUDGET_MS) break;
      }
      this.flushSerial();
      if (this.deps.now() - this.lastFrameWall >= FRAME_INTERVAL_MS) this.postFrame();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.queueTick();
  };

  private flushSerial(): void {
    const bench = this.bench;
    for (const [board, chunks] of this.serial) {
      if (chunks.length === 0) continue;
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      chunks.length = 0;
      bench?.input(board, SERIAL_TX);
      this.deps.post({ type: 'serial', board, bytes, t: bench?.now() ?? 0 }, [bytes.buffer]);
    }
  }

  private postFrame(): void {
    const bench = this.bench;
    if (bench === null) return;
    const wall = this.deps.now();
    const frame = bench.collectFrame();
    for (const [id, visual] of frame.parts) this.latest.set(id, visual);
    const probes: ProbeChunk[] = [];
    const transfer: ArrayBuffer[] = [];
    for (const [key, probe] of this.probes) {
      if (probe.id < 0) continue;
      const read = bench.readProbe(probe.id, probe.since, MAX_FRAME_EDGES);
      if (read === undefined) continue;
      const peripheral = bench.probePeripheral(probe.id);
      if (read.times.length === 0 && !probe.restart && peripheral === probe.peripheral) continue;
      probe.since = read.from + read.times.length;
      probes.push({ key, from: read.from, times: read.times, levels: read.levels, lost: read.lost, peripheral, restart: probe.restart });
      transfer.push(read.times.buffer as ArrayBuffer, read.levels.buffer as ArrayBuffer);
      probe.restart = false;
      probe.peripheral = peripheral;
    }
    // With a frame ring, only the states that didn't fit a slot travel in the message.
    const ring = this.ring;
    // Audio blocks and TFT updates are streams: they always travel in the message (the ring keeps
    // only each part's latest state).
    const parts = ring === null ? frame.parts : frame.parts.filter(([id, visual]) => 'audio' in visual || 'tftPixels' in visual || !ring.write(id, visual));
    this.deps.post(
      {
        type: 'frame',
        t: frame.t,
        parts,
        stats: { ratio: this.running ? this.pacer.ratio() : 0, mhz: this.measureMhz(wall) },
        running: this.running,
        probes,
      },
      transfer,
    );
    this.lastFrameWall = wall;
    this.postProblems(false);
  }

  /** Executed MHz per board since the previous frame (kept while paused). */
  private measureMhz(wall: number): Record<string, number> {
    const mhz: Record<string, number> = {};
    for (const [board, mcu] of this.env.mcus) mhz[board] = this.mhzOf(board, mcu, wall);
    return mhz;
  }

  private mhzOf(board: string, mcu: Mcu, wall: number): number {
    const mark = this.cycleMarks.get(board);
    const cycles = mcu.cycles;
    if (mark === undefined || cycles < mark.cycles) {
      this.cycleMarks.set(board, { cycles, wall, mhz: 0 });
      return 0;
    }
    if (!this.running) {
      mark.cycles = cycles;
      mark.wall = wall;
      return 0;
    }
    const elapsedMs = wall - mark.wall;
    if (elapsedMs > 0) {
      mark.mhz = (cycles - mark.cycles) / (elapsedMs * 1000);
      mark.cycles = cycles;
      mark.wall = wall;
    }
    return mark.mhz;
  }

  private postProblems(force: boolean): void {
    const bench = this.bench;
    if (bench === null) return;
    const list = [...bench.problems()];
    const key = problemsKey(list);
    if (!force && key === this.problemsKey) return;
    this.problemsKey = key;
    const counts = { error: 0, warning: 0, info: 0 };
    for (const p of list) counts[p.severity]++;
    this.post({ type: 'problems', list, counts });
  }

  private requireBench(): Bench {
    if (this.bench === null) throw new Error('nothing loaded');
    return this.bench;
  }

  private post(message: FromSim): void {
    this.deps.post(message, []);
  }

  private fail(error: unknown): void {
    this.running = false;
    this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

/** Identifies firmware contents cheaply (FNV-1a over the bytes or text). */
function firmwareKey(image: FirmwareImage | undefined): string {
  if (image === undefined) return '';
  let hash = 0x811c9dc5;
  const mix = (v: number): void => {
    hash = Math.imul(hash ^ v, 0x01000193) >>> 0;
  };
  if (image.format === 'hex') for (let i = 0; i < image.text.length; i++) mix(image.text.charCodeAt(i));
  else if (image.format === 'elf') for (let i = 0; i < image.bytes.length; i++) mix(image.bytes[i]);
  else for (let i = 0; i < image.app.length; i++) mix(image.app[i]);
  return `${image.format}:${hash.toString(16)}`;
}

function problemsKey(list: readonly Problem[]): string {
  return list.map((p) => `${p.severity}|${p.code}|${p.parts.join(',')}|${p.message}`).join('\n');
}
