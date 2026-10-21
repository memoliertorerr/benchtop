/**
 * The Debugger tab (BT24): Continue/Pause (F8), Step over (F10), Step (F11) — the keys act only
 * while the tab has focus —, the location line, a registers grid and a 256-byte memory view
 * (both refreshed only while stopped), and the breakpoint list (an address, a function or
 * file:line). Source text isn't shown: the compile bridge serves no sketch source yet, so the
 * location names file:line only.
 */

import type { MemorySpace } from '@benchtop/core';
import { useEffect, useState } from 'preact/hooks';
import { run } from '../../sim/controller.ts';
import { sim, simLoaded, simRunning } from '../../sim/host.ts';
import { describeLocation, formatSreg, resolveAddress } from './resolve.ts';
import {
  addBreakpoint,
  currentBoard,
  debugInfo,
  debugStops,
  memoryView,
  readMemory,
  removeBreakpoint,
  resolvedBreakpoints,
  selectedBoard,
  tablesOf,
} from './store.ts';

const hex = (n: number, digits: number): string => n.toString(16).padStart(digits, '0');
const REASONS = { breakpoint: 'breakpoint', step: 'step', pause: 'paused' } as const;

function Registers({ registers }: { registers: Uint32Array }) {
  return (
    <div class="debug-registers" aria-label="Registers">
      {Array.from({ length: 32 }, (_, i) => (
        <span key={i} class="debug-reg">
          <span class="debug-reg-name">R{i}</span>
          {hex(registers[i], 2)}
        </span>
      ))}
      <span class="debug-reg wide">
        <span class="debug-reg-name">SREG</span>
        {formatSreg(registers[32])}
      </span>
      <span class="debug-reg wide">
        <span class="debug-reg-name">SP</span>
        {hex(registers[33], 4)}
      </span>
      <span class="debug-reg wide">
        <span class="debug-reg-name">PC</span>
        {hex(registers[34], 4)}
      </span>
    </div>
  );
}

function Memory({ board, stopped }: { board: string; stopped: boolean }) {
  const [space, setSpace] = useState<MemorySpace>('data');
  const [text, setText] = useState('0x100');
  const [error, setError] = useState('');
  const tables = tablesOf(board);
  const address = resolveAddress(text, tables);
  // Re-read while stopped: on every stop and whenever the address or space changes.
  const stop = debugStops.value.get(board);
  useEffect(() => {
    if (!stopped || address === undefined) return;
    readMemory(board, space, address);
  }, [board, space, address, stopped, stop]);
  useEffect(() => setError(address === undefined && text.trim() !== '' ? 'not an address or symbol' : ''), [address, text]);
  const view = memoryView.value;
  const shown = view !== null && view.board === board && view.space === space && view.addr === address ? view : null;
  const rows: string[] = [];
  if (shown !== null) {
    for (let at = 0; at < shown.bytes.length; at += 16) {
      const chunk = shown.bytes.subarray(at, at + 16);
      const bytes = Array.from(chunk, (b) => hex(b, 2)).join(' ');
      const ascii = Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
      rows.push(`${hex(shown.addr + at, 4)}  ${bytes.padEnd(47)}  ${ascii}`);
    }
  }
  return (
    <div class="debug-memory">
      <div class="debug-row">
        <select class="tool-select" aria-label="Memory space" value={space} onChange={(e) => setSpace((e.target as HTMLSelectElement).value as MemorySpace)}>
          <option value="data">data (SRAM, I/O)</option>
          <option value="flash">flash</option>
          <option value="eeprom">EEPROM</option>
        </select>
        <input
          class="debug-input"
          aria-label="Memory address"
          value={text}
          placeholder="0x100 or a symbol"
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
        {error !== '' && <span class="debug-error">{error}</span>}
      </div>
      <pre class="debug-hex">{!stopped ? 'Running — memory shows while stopped.' : shown === null ? '…' : shown.bytes.length === 0 ? 'Past the end of this space.' : rows.join('\n')}</pre>
    </div>
  );
}

function Breakpoints({ board }: { board: string }) {
  const [text, setText] = useState('');
  const list = resolvedBreakpoints.value.filter((b) => b.board === board);
  const add = (): void => {
    addBreakpoint(board, text);
    setText('');
  };
  return (
    <div class="debug-breakpoints">
      <div class="debug-row">
        <input
          class="debug-input"
          aria-label="New breakpoint"
          value={text}
          placeholder="0x05b2, addSlow or sketch.ino:23"
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <button type="button" class="chip" onClick={add} disabled={text.trim() === ''}>
          Add breakpoint
        </button>
      </div>
      <ul class="debug-bp-list">
        {list.length === 0 && <li class="muted">No breakpoints.</li>}
        {list.map((b) => (
          <li key={b.id}>
            <span class={`debug-bp-dot${b.resolved.ok ? '' : ' unresolved'}`} />
            <span class="debug-bp-text">{b.text}</span>
            <span class={b.resolved.ok ? 'muted' : 'debug-error'}>
              {b.resolved.ok ? b.resolved.addresses.map((a) => `0x${hex(a, 4)}`).join(', ') : b.resolved.error}
            </span>
            <button type="button" class="logic-remove" title={`Remove ${b.text}`} onClick={() => removeBreakpoint(b.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Debugger() {
  const board = currentBoard.value;
  const boards = [...debugInfo.value.keys()];
  const running = simRunning.value;
  if (!simLoaded.value || board === null) return <p class="muted panel-note">Load a project with an Uno to debug its firmware.</p>;
  const tables = tablesOf(board);
  const stop = debugStops.value.get(board);
  const stopped = !running && stop !== undefined;
  const toggle = (): void => (running ? sim.debugPause() : run());
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'F8') toggle();
    else if (event.key === 'F10' && !running) sim.debugStepOver(board);
    else if (event.key === 'F11' && !running) sim.debugStep(board);
    else return;
    event.preventDefault();
  };
  return (
    <div class="debugger" tabIndex={0} onKeyDown={onKeyDown} aria-label="Debugger (F8 continue/pause, F10 step over, F11 step)">
      <div class="serial-bar">
        {boards.length > 1 && (
          <select class="tool-select" aria-label="Board" value={board} onChange={(e) => (selectedBoard.value = (e.target as HTMLSelectElement).value)}>
            {boards.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        )}
        <button type="button" class="chip" onClick={toggle} title="Continue / Pause (F8)">
          {running ? 'Pause' : 'Continue'}
        </button>
        <button type="button" class="chip" disabled={running} onClick={() => sim.debugStepOver(board)} title="Step over (F10)">
          Step over
        </button>
        <button type="button" class="chip" disabled={running} onClick={() => sim.debugStep(board)} title="Step one instruction (F11)">
          Step
        </button>
        <span class="debug-location">
          {running ? 'running…' : stop === undefined ? '' : `${REASONS[stop.reason]} · ${describeLocation(stop.pc, tables)}`}
        </span>
      </div>
      {tables.error !== null && <p class="debug-error panel-note">Debug info: {tables.error}</p>}
      {tables.error === null && tables.symbols === null && (
        <p class="muted panel-note">This firmware is a .hex: load the .elf for symbols and source lines (addresses still work).</p>
      )}
      <div class="debug-body">
        <div class="debug-column">
          {stopped ? <Registers registers={stop.registers} /> : <p class="muted panel-note">Registers show while stopped.</p>}
          <Breakpoints board={board} />
        </div>
        <Memory board={board} stopped={stopped} />
      </div>
    </div>
  );
}
