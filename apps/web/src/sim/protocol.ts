/**
 * Messages between the UI thread and the simulation worker. The worker owns every MCU and
 * part model; the UI only renders what the worker reports and forwards user input. Bump
 * PROTOCOL_VERSION whenever a message shape changes. Uint8Array payloads travel in the
 * postMessage transfer list.
 */

import type {
  FirmwareImage,
  LineTableData,
  MemorySpace,
  Nanos,
  PartInput,
  PinRef,
  Problem,
  ProjectDoc,
  SymbolTableData,
  VisualState,
} from '@benchtop/core';

export const PROTOCOL_VERSION = 12;

export type ToSim =
  | { type: 'hello'; protocol: number }
  /** Builds a new bench from `doc` (paused at t = 0) and loads firmware per board part id. */
  /** `debugElf` (BT74): a board's ELF for the debugger's symbols and lines when its image isn't one (a .hex, .uf2 or .bin built from it). */
  | { type: 'load'; doc: ProjectDoc; firmware: Record<string, FirmwareImage>; debugElf?: Record<string, Uint8Array> }
  /**
   * BT79: the loaded bench's document changed (an edit while loaded): the bench is rebuilt with
   * carry-over — time, unchanged boards (still running their firmware) and unchanged parts'
   * state continue; `firmware` is loaded only into boards that are new or whose firmware ref
   * changed. Keeps running if it was. Answered with `edited`.
   */
  | { type: 'edit'; doc: ProjectDoc; firmware: Record<string, FirmwareImage>; debugElf?: Record<string, Uint8Array> }
  /**
   * New firmware for one board of the loaded bench (a fresh compile): loads it and resets that
   * board's MCU only; its clock restarts at the current bench time, other parts keep their state
   * and a running bench keeps running.
   */
  | { type: 'setFirmware'; board: string; image: FirmwareImage; debugElf?: Uint8Array }
  /** Runs in real time × `speed` (Infinity = as fast as possible). */
  | { type: 'run'; speed: number }
  | { type: 'pause' }
  /** Bench reset: time 0, every MCU and part reset. Keeps running if it was. */
  | { type: 'reset' }
  /** Pauses, then advances exactly `ns` of simulated time and posts a frame. */
  | { type: 'step'; ns: number }
  | { type: 'input'; part: string; event: PartInput }
  /**
   * Microphone samples (BT41): −1…1 at 16 kHz, in order, for a microphone part — each becomes a
   * `value` input. The buffer is transferred.
   */
  | { type: 'audioIn'; part: string; samples: Float32Array }
  /** Bytes for a board's UART 0 receiver. */
  | { type: 'serialSend'; board: string; bytes: Uint8Array }
  /** Record a pin's net under `key` (kept across reloads until removed). */
  | { type: 'addProbe'; key: string; pin: PinRef }
  | { type: 'removeProbe'; key: string }
  /** Debugger (BT24). Pause stops the run and reports where each debuggable board is. */
  | { type: 'debugPause' }
  | { type: 'debugStep'; board: string }
  /** A call runs until it returns (at max speed); anything else is one step. */
  | { type: 'debugStepOver'; board: string }
  /**
   * The board's whole breakpoint set as typed (0x… address, function, file:line); the worker
   * keeps it and resolves it against each firmware it loads, before the first instruction.
   */
  | { type: 'debugSetBreakpoints'; board: string; specs: string[] }
  | { type: 'debugReadMemory'; board: string; space: MemorySpace; addr: number; len: number }
  /**
   * BT50: resets the bench (as `reset`) and records every `input` and `serialSend` from now on
   * with its simulated time. Keeps running if it was.
   */
  | { type: 'recordStart' }
  /** Pauses, runs on to the next whole millisecond, and posts `recorded`. */
  | { type: 'recordStop' };

/** A recorded step (BT50): a part input, or text typed into a board's serial monitor. */
export type RecordedStep = { at: Nanos; part: string; input: PartInput } | { at: Nanos; board: string; serial: string };

/** A finished recording: its length, steps, and the expectations that held at its end. */
export interface RecordedTest {
  durationNs: Nanos;
  steps: RecordedStep[];
  proposals: string[];
  /** Inputs past the recording's step limit (not kept). */
  dropped: number;
}

/** Why a debuggable board is not running. */
export type DebugStopReason = 'breakpoint' | 'step' | 'pause';

/** A probe's edges since the previous frame (transferred). */
export interface ProbeChunk {
  key: string;
  /** Absolute index of the first edge sent (0 after a load or reset). */
  from: number;
  times: Float64Array;
  /** 0, 1, 2 = floating (z), 3 = conflict (x). */
  levels: Uint8Array;
  /** Edges not sent: overwritten in the worker's ring, or over the 65,536-per-frame cap. */
  lost: number;
  /** The net is driven by a peripheral the simulation doesn't draw (hardware UART TX …). */
  peripheral: boolean;
  /** Time restarted (load or reset): drop what was recorded before. */
  restart: boolean;
}

export interface ProblemCounts {
  error: number;
  warning: number;
  info: number;
}

export interface FrameStats {
  /** Simulated time per wall time over the last second (1 = real time). */
  ratio: number;
  /** Simulated clock rate per board part id, in MHz of executed cycles per wall second. */
  mhz: Record<string, number>;
}

export type FromSim =
  | { type: 'ready'; protocol: number }
  | { type: 'loaded'; problems: Problem[] }
  /** BT79: an `edit` was applied (or, when carrying over failed, the bench was loaded afresh: `reloaded`). */
  | { type: 'edited'; problems: Problem[]; reloaded: boolean }
  /**
   * Sent after each load when the worker is cross-origin isolated (BT40): from now on the parts'
   * visual state is published in this shared buffer (frame-ring.ts; one slot per part, in
   * `parts` order) and `frame` messages carry only states that didn't fit a slot.
   */
  | { type: 'frameRing'; buffer: SharedArrayBuffer; parts: string[] }
  /**
   * Visual state of the parts that changed since the previous frame (those not in the frame
   * ring). A speaker's state carries its audio blocks (`audio`, `audioT`): a stream, never put
   * in the ring, which keeps only each part's latest state.
   */
  | { type: 'frame'; t: Nanos; parts: [string, VisualState][]; stats: FrameStats; running: boolean; probes: ProbeChunk[] }
  /** Bytes a board's UART 0 sent; `t` is the simulated time (ns) when they were flushed. */
  | { type: 'serial'; board: string; bytes: Uint8Array; t: Nanos }
  /**
   * A board's symbols and DWARF line table, parsed in the worker once per firmware (null for a
   * .hex, which has neither; `error` when the ELF's debug info didn't parse). Typed arrays are
   * transferred.
   */
  | {
      type: 'debugInfo';
      board: string;
      symbols: SymbolTableData | null;
      lines: LineTableData | null;
      error: string | null;
      /** BT74: the MCU (`Mcu.kind`) and its registers in debugger order (names, widths). */
      kind: string;
      registers: { name: string; bits: number }[];
    }
  /** A debuggable board stopped: where, and its registers (debugger order). */
  | { type: 'debugStopped'; board: string; reason: DebugStopReason; pc: number; registers: Uint32Array }
  /** Bytes for a debugReadMemory (shorter than asked at the end of a space; empty past it). */
  | { type: 'debugMemory'; board: string; space: MemorySpace; addr: number; bytes: Uint8Array }
  /** The full problem list with its counts by severity, sent only when the set changes. */
  | { type: 'problems'; list: Problem[]; counts: ProblemCounts }
  /** A test recording ended (BT50). */
  | { type: 'recorded'; test: RecordedTest }
  | { type: 'error'; message: string };
