/**
 * Debugger state on the UI side: each board's symbols and line table (parsed in the worker and
 * transferred), where each board stopped, the last memory read, and the breakpoint list. The
 * list holds what the user typed (an address, a function or file:line) and is saved to
 * localStorage. The worker gets each board's texts whenever they change (and when it starts)
 * and resolves them itself at every load, so they are armed before the first instruction; the
 * UI resolves them too, only to show what each one became.
 */

import { type DebugTables, LineTable, type MemorySpace, resolveBreakpoint, type ResolvedBreakpoint, SymbolTable } from '@benchtop/core';
import { computed, effect, signal } from '@preact/signals';
import type { DebugStopReason } from '../../sim/protocol.ts';
import { onDebug, onFrame, sim, simStatus } from '../../sim/host.ts';

export interface BoardDebugInfo extends DebugTables {
  error: string | null;
  /** BT74: the MCU (`Mcu.kind`) and its registers in debugger order. */
  kind: string;
  registers: readonly { name: string; bits: number }[];
}

export interface DebugStop {
  reason: DebugStopReason;
  pc: number;
  registers: Uint32Array;
}

export interface BreakpointSpec {
  id: number;
  board: string;
  text: string;
}

export interface MemoryView {
  board: string;
  space: MemorySpace;
  addr: number;
  bytes: Uint8Array;
}

const STORAGE_KEY = 'benchtop:breakpoints:v1';

export const debugInfo = signal<ReadonlyMap<string, BoardDebugInfo>>(new Map());
export const debugStops = signal<ReadonlyMap<string, DebugStop>>(new Map());
export const memoryView = signal<MemoryView | null>(null);
export const breakpointSpecs = signal<readonly BreakpointSpec[]>(readStored());
/** The board the tab shows (the first debuggable one unless the user picks another). */
export const selectedBoard = signal<string | null>(null);

export const currentBoard = computed(() => {
  const chosen = selectedBoard.value;
  const boards = [...debugInfo.value.keys()];
  return chosen !== null && boards.includes(chosen) ? chosen : (boards[0] ?? null);
});

const NO_TABLES: BoardDebugInfo = { symbols: null, lines: null, error: null, kind: '', registers: [] };

export function tablesOf(board: string | null): BoardDebugInfo {
  return (board !== null ? debugInfo.value.get(board) : undefined) ?? NO_TABLES;
}

/** Each spec with what it resolves to on its board right now. */
export const resolvedBreakpoints = computed(() =>
  breakpointSpecs.value.map((spec): BreakpointSpec & { resolved: ResolvedBreakpoint } => ({ ...spec, resolved: resolveBreakpoint(spec.text, tablesOf(spec.board)) })),
);

function readStored(): BreakpointSpec[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value
      .filter((b): b is BreakpointSpec => typeof b?.id === 'number' && typeof b?.board === 'string' && typeof b?.text === 'string' && b.text.length <= 200)
      .slice(0, 64);
  } catch {
    return [];
  }
}

export function addBreakpoint(board: string, text: string): void {
  const spec = text.trim();
  if (spec === '' || breakpointSpecs.peek().some((b) => b.board === board && b.text === spec)) return;
  const id = Math.max(0, ...breakpointSpecs.peek().map((b) => b.id)) + 1;
  breakpointSpecs.value = [...breakpointSpecs.peek(), { id, board, text: spec }];
}

export function removeBreakpoint(id: number): void {
  breakpointSpecs.value = breakpointSpecs.peek().filter((b) => b.id !== id);
}

export function readMemory(board: string, space: MemorySpace, addr: number): void {
  sim.debugReadMemory(board, space, addr, 256);
}

// Save the list; send each board's texts when they change or the worker (re)starts.
let sent = new Map<string, string>();
effect(() => {
  const specs = breakpointSpecs.value;
  const ready = simStatus.value === 'ready';
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(specs));
  } catch {
    // storage blocked: the list lives for the session
  }
  if (!ready) {
    sent = new Map();
    return;
  }
  const byBoard = new Map<string, string[]>();
  for (const board of sent.keys()) byBoard.set(board, []); // a board whose last one was removed
  for (const b of specs) byBoard.set(b.board, [...(byBoard.get(b.board) ?? []), b.text]);
  for (const [board, texts] of byBoard) {
    const key = JSON.stringify(texts);
    if (sent.get(board) === key) continue;
    sent.set(board, key);
    sim.debugSetBreakpoints(board, texts);
  }
});

onDebug((message) => {
  switch (message.type) {
    case 'debugInfo': {
      const next = new Map(debugInfo.peek());
      next.set(message.board, {
        symbols: message.symbols === null ? null : new SymbolTable(message.symbols),
        lines: message.lines === null ? null : new LineTable(message.lines),
        error: message.error,
        kind: message.kind,
        registers: message.registers,
      });
      debugInfo.value = next;
      return;
    }
    case 'debugStopped': {
      const next = new Map(debugStops.peek());
      next.set(message.board, { reason: message.reason, pc: message.pc, registers: message.registers });
      debugStops.value = next;
      return;
    }
    case 'debugMemory':
      memoryView.value = { board: message.board, space: message.space, addr: message.addr, bytes: message.bytes };
      return;
  }
});

// Running again: no board is stopped.
onFrame((frame) => {
  if (frame.running && debugStops.peek().size > 0) debugStops.value = new Map();
});
