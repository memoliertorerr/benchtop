import { type FirmwareRef, isMicroPythonFqbn } from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';
import { useRef } from 'preact/hooks';
import { editor, editorMessage } from '../editor/app-store.ts';
import { attachFirmwareFile } from '../editor/firmware-actions.ts';
import { firmwareStore } from '../editor/firmware-store.ts';
import { micropythonFqbnOf } from '../editor/fqbn.ts';
import { templateRef } from '../editor/inline-compile.ts';
import { compileNow, fqbnOf, recentFolders, type SketchStatus, setSketchFolder, setWatching, statusOf } from '../editor/sketch-actions.ts';
import { WIRE_COLORS, WIRE_SHADES } from '../editor/wiring.ts';
import { PartControls } from './PartControls.tsx';

/** Edits the selected part's props, by the type of each default value. */
import { viewMode } from '../pcb/mode.ts';
import { lazyComponent } from './lazy.tsx';

const PcbInspector = lazyComponent(() => import('../pcb/PcbInspector.tsx').then((m) => m.PcbInspector));

export function Inspector() {
  if (viewMode.value === 'pcb') return <PcbInspector />;
  const doc = editor.doc.value;
  const selection = editor.selection.value;
  const wireId = editor.selectedWire.value;
  const wire = wireId === null ? undefined : doc.wires.find((w) => w.id === wireId);

  if (wire !== undefined) {
    return (
      <aside class="inspector" aria-label="Inspector">
        <div class="panel-title">Inspector</div>
        <div class="inspector-heading">Wire</div>
        <dl class="inspector-facts">
          <dt>Id</dt>
          <dd>{wire.id}</dd>
          <dt>From</dt>
          <dd>
            {wire.from.part}:{wire.from.pin}
          </dd>
          <dt>To</dt>
          <dd>
            {wire.to.part}:{wire.to.pin}
          </dd>
          <dt>Bends</dt>
          <dd>{wire.waypoints.length} waypoints</dd>
        </dl>
        <div class="field-label">Color</div>
        <div class="swatches" role="radiogroup" aria-label="Wire color">
          {WIRE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={wire.color === color}
              aria-label={color}
              title={color}
              class={`swatch${wire.color === color ? ' active' : ''}`}
              style={{ background: WIRE_SHADES[color] }}
              onClick={() => editor.updateWire(wire.id, { color })}
            />
          ))}
        </div>
        <button type="button" class="tool-button danger-button" onClick={() => editor.deleteWire(wire.id)}>
          Delete wire
        </button>
        <p class="muted hint">Drag the square handles to move bends.</p>
      </aside>
    );
  }

  if (selection.size === 0) {
    return (
      <aside class="inspector" aria-label="Inspector">
        <div class="panel-title">Inspector</div>
        <p class="muted">Select a part or a wire to edit it.</p>
        <p class="muted hint">
          Click a pin to start a wire, click to add bends, click another pin to finish (Esc cancels). R rotates ·
          Backspace deletes · ⌘Z / ⌘⇧Z undo and redo · Alt while dragging skips the grid.
        </p>
      </aside>
    );
  }
  if (selection.size > 1) {
    return (
      <aside class="inspector" aria-label="Inspector">
        <div class="panel-title">Inspector</div>
        <p>{selection.size} parts selected</p>
      </aside>
    );
  }
  const [id] = selection;
  const part = doc.parts.find((p) => p.id === id);
  const def = part && CATALOG.get(part.type);
  if (part === undefined || def === undefined) return <aside class="inspector" aria-label="Inspector" />;
  const firmware = doc.firmware[part.id];

  return (
    <aside class="inspector" aria-label="Inspector">
      <div class="panel-title">Inspector</div>
      <div class="inspector-heading">{def.title}</div>
      <dl class="inspector-facts">
        <dt>Id</dt>
        <dd>{part.id}</dd>
        <dt>Position</dt>
        <dd>
          {part.x.toFixed(2)}, {part.y.toFixed(2)} mm
        </dd>
        <dt>Rotation</dt>
        <dd>{part.rotation}°</dd>
      </dl>
      {def.board !== undefined && (
        <div class="firmware-box">
          <LanguageSwitch board={part.id} type={part.type} firmware={firmware} />
          <div class="field-label">Firmware</div>
          <div class="firmware-name">
            {firmware === undefined
              ? 'none — drop a .hex or .elf on the board, or set a sketch folder'
              : firmware.kind === 'file'
                ? firmware.name
                : (firmwareStore.get(part.id)?.name ?? (isPython(firmware) ? 'not run yet' : 'not compiled yet'))}
          </div>
          <FirmwareButton board={part.id} />
          {isPython(firmware) ? (
            <p class="muted panel-note">MicroPython: write main.py in the Code tab and press Run — nothing to compile.</p>
          ) : (
            <SketchControls board={part.id} type={part.type} sketch={firmware?.kind === 'sketch' ? firmware.path : undefined} />
          )}
        </div>
      )}
      <PartControls part={part} defaults={def.defaults} />
      {Object.entries(def.defaults).map(([key, fallback]) => {
        const value = part.props[key] ?? fallback;
        const label = <span class="field-label">{key}</span>;
        if (typeof fallback === 'boolean') {
          return (
            <label key={key} class="field field-check">
              <input
                type="checkbox"
                checked={value === true}
                onChange={(event) => editor.setProp(part.id, key, (event.target as HTMLInputElement).checked)}
              />
              {label}
            </label>
          );
        }
        return (
          <label key={key} class="field">
            {label}
            <input
              type={typeof fallback === 'number' ? 'number' : 'text'}
              step="any"
              value={String(value)}
              onChange={(event) => {
                const raw = (event.target as HTMLInputElement).value;
                if (typeof fallback === 'number') {
                  const n = Number(raw);
                  if (raw.trim() !== '' && Number.isFinite(n)) editor.setProp(part.id, key, n);
                } else {
                  editor.setProp(part.id, key, raw);
                }
              }}
            />
          </label>
        );
      })}
    </aside>
  );
}

const isPython = (ref: FirmwareRef | undefined): boolean => ref?.kind === 'inline' && isMicroPythonFqbn(ref.fqbn);

/**
 * BT63: Arduino C++ or MicroPython, on boards MicroPython runs on. Switching starts the other
 * language's template sketch (undoable); the old firmware runs until the first Run.
 */
function LanguageSwitch({ board, type, firmware }: { board: string; type: string; firmware: FirmwareRef | undefined }) {
  const python = micropythonFqbnOf(type);
  const arduino = fqbnOf(type);
  if (python === undefined || arduino === undefined) return null;
  const choose = (toPython: boolean): void => {
    if (toPython === isPython(firmware)) return;
    if (firmware?.kind === 'inline' && !window.confirm(`Switch ${board} to ${toPython ? 'MicroPython' : 'Arduino C++'}? Its sketch is replaced by a template (Undo brings it back).`)) return;
    editor.setFirmware(board, templateRef(toPython ? python : arduino));
    editorMessage.value = toPython ? `${board} runs MicroPython now: edit main.py in the Code tab and press Run.` : `${board} runs Arduino C++ again: write its sketch in the Code tab and Compile & Run.`;
  };
  return (
    <label class="field">
      <span class="field-label">Language</span>
      <select class="tool-select" value={isPython(firmware) ? 'micropython' : 'arduino'} onChange={(event) => choose((event.target as HTMLSelectElement).value === 'micropython')}>
        <option value="arduino">Arduino C++</option>
        <option value="micropython">MicroPython</option>
      </select>
    </label>
  );
}

function FirmwareButton({ board }: { board: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" class="tool-button" onClick={() => input.current?.click()}>
        Load firmware…
      </button>
      <input
        ref={input}
        type="file"
        accept=".hex,.elf,.bin,.uf2,.py"
        hidden
        onChange={(event) => {
          const el = event.target as HTMLInputElement;
          const file = el.files?.[0];
          el.value = '';
          if (file !== undefined) void attachFirmwareFile(board, file);
        }}
      />
    </>
  );
}

const BADGES: Record<SketchStatus['phase'], string> = { idle: 'idle', compiling: 'compiling…', ok: 'ok', error: 'error' };

function SketchBadge({ status }: { status: SketchStatus }) {
  let text = BADGES[status.phase];
  if (status.phase === 'ok') text = `ok in ${status.detail} s`;
  if (status.phase === 'error' && status.detail !== '') text = `error · ${status.detail}`;
  if (status.watching && !status.connected && status.phase !== 'compiling') text = `${text} · waiting for bridge`;
  return (
    <span class={`sketch-badge ${status.phase}`} title={status.detail}>
      {text}
    </span>
  );
}

/** Sketch folder, FQBN, Compile, Watch and the compile status for a board (via the bridge). */
function SketchControls({ board, type, sketch }: { board: string; type: string; sketch: string | undefined }) {
  const fqbn = fqbnOf(type);
  if (fqbn === undefined) return null;
  const status = statusOf(board);
  const listId = `sketch-folders-${board}`;
  return (
    <div class="sketch-controls">
      <label class="field">
        <span class="field-label">Sketch folder</span>
        <input
          type="text"
          list={listId}
          placeholder="/Users/you/Arduino/Blink"
          spellcheck={false}
          value={sketch ?? ''}
          onChange={(event) => setSketchFolder(board, type, (event.target as HTMLInputElement).value)}
        />
        <datalist id={listId}>
          {recentFolders.value.map((path) => (
            <option key={path} value={path} />
          ))}
        </datalist>
      </label>
      <div class="sketch-fqbn">
        <span class="muted">FQBN</span> <code>{fqbn}</code>
      </div>
      <div class="sketch-row">
        <button type="button" class="tool-button" disabled={sketch === undefined || status.phase === 'compiling'} onClick={() => void compileNow(board)}>
          Compile
        </button>
        <label class="chip-check">
          <input
            type="checkbox"
            checked={status.watching}
            disabled={sketch === undefined}
            onChange={(event) => setWatching(board, (event.target as HTMLInputElement).checked)}
          />
          Watch
        </label>
        <SketchBadge status={status} />
      </div>
    </div>
  );
}
