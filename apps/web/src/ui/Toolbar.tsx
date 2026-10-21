import { emptyProject } from '@benchtop/core';
import { importWokwiDiagram } from '@benchtop/parts';
import { useRef } from 'preact/hooks';
import { editor, editorMessage } from '../editor/app-store.ts';
import { benchSvg, imageSizeMm, svgToPng } from '../editor/export-image.ts';
import { copyShareLink } from '../editor/share-actions.ts';
import { frameDoc } from '../editor/frame.ts';
import { importNotes } from '../editor/import-notes.ts';
import { shortcutsOpen } from '../editor/shortcuts.ts';
import { parseProjectText, serializeProject } from '../editor/persistence.ts';
import { pause, recordTest, reset, run, setSpeed, SPEEDS, speed, stopRecording, testRecording } from '../sim/controller.ts';
import { simRunning, simStats, simStatus } from '../sim/host.ts';
import { muted, toggleMute } from './audio.ts';
import { galleryOpen } from './ExamplesGallery.tsx';
import { ChipIcon, PauseIcon, PlayIcon, ProbeIcon, RecordIcon, ResetIcon, SpeakerIcon, SpeakerOffIcon, StopIcon } from './icons.tsx';
import { probeMode } from './logic/probes.ts';
import { resetPcb, viewMode } from '../pcb/mode.ts';

/** The PCB file actions (BT59) live in the PCB chunk. */
const pcbActions = () => import('../pcb/actions.ts');

/** A `.pcb.json` (format 1 with an outline and footprints) rather than a project. */
function isPcbDocument(json: unknown): boolean {
  return typeof json === 'object' && json !== null && (json as { format?: unknown }).format === 1 && Array.isArray((json as { outline?: unknown }).outline) && Array.isArray((json as { footprints?: unknown }).footprints);
}

const fileStem = (name: string): string => name.replace(/[^\w.-]+/g, '-') || 'benchtop';

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportProject(): void {
  const doc = editor.doc.value;
  download(new Blob([serializeProject(doc)], { type: 'application/json' }), `${fileStem(doc.name)}.json`);
}

/** The bench as it looks now (BT40), as an SVG or a PNG at 2×. */
async function exportImage(format: 'svg' | 'png'): Promise<void> {
  const doc = editor.doc.value;
  const world = document.querySelector<HTMLElement>('.workbench .world');
  const bench = document.querySelector<HTMLElement>('.workbench');
  if (world === null || bench === null || doc.parts.length === 0) {
    editorMessage.value = 'Nothing on the bench to export.';
    return;
  }
  try {
    const svg = benchSvg(doc, world, getComputedStyle(bench).backgroundColor);
    if (format === 'svg') {
      download(new Blob([svg], { type: 'image/svg+xml' }), `${fileStem(doc.name)}.svg`);
    } else {
      const size = imageSizeMm(doc);
      download(await svgToPng(svg, size.w, size.h), `${fileStem(doc.name)}.png`);
    }
  } catch (error) {
    editorMessage.value = `Could not export the image: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Export ▾: the project file, or the bench as an image. */
function ExportMenu() {
  const menu = useRef<HTMLDetailsElement>(null);
  const pick = (action: () => void) => () => {
    if (menu.current !== null) menu.current.open = false;
    action();
  };
  return (
    <details ref={menu} class="menu">
      <summary class="tool-button" title="Save the project, or the bench as an image">
        Export ▾
      </summary>
      <div class="menu-list" role="menu">
        <button type="button" role="menuitem" onClick={pick(exportProject)}>
          Project (.json)
        </button>
        <button type="button" role="menuitem" onClick={pick(() => void exportImage('png'))}>
          Image (.png, 2×)
        </button>
        <button type="button" role="menuitem" onClick={pick(() => void exportImage('svg'))}>
          Image (.svg)
        </button>
        <button type="button" role="menuitem" onClick={pick(() => void copyShareLink())}>
          Copy share link
        </button>
        <button type="button" role="menuitem" onClick={pick(() => void pcbActions().then((m) => m.exportFabricationZip()))} title="Gerbers, drill file, BOM and KiCad netlist + footprints, in one ZIP">
          PCB fabrication files (.zip)
        </button>
        <button type="button" role="menuitem" onClick={pick(() => void pcbActions().then((m) => m.exportPcbLayout()))}>
          PCB layout (.pcb.json)
        </button>
      </div>
    </details>
  );
}

/** A Wokwi diagram.json rather than a Benchtop project: a parts array, no `format`. */
function isWokwiDiagram(json: unknown): boolean {
  return typeof json === 'object' && json !== null && !('format' in json) && Array.isArray((json as { parts?: unknown }).parts);
}

/** Open…: a Benchtop project, or a Wokwi diagram.json imported (BT38; what didn't come over is listed in Problems). */
async function importProject(file: File): Promise<void> {
  if (file.size > 4 * 1024 * 1024) {
    editorMessage.value = `${file.name} is larger than 4 MB; not a project file.`;
    return;
  }
  const text = await file.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (isPcbDocument(json)) {
    void pcbActions().then((m) => m.openPcbDocument(json, file.name));
    return;
  }
  if (isWokwiDiagram(json)) {
    const result = importWokwiDiagram(json, file.name.replace(/\.json$/i, '').replace(/^diagram$/i, 'Imported diagram'));
    importNotes.value = result.warnings;
    if (!result.ok) {
      editorMessage.value = `Could not import ${file.name}: ${result.error}`;
      return;
    }
    editor.replaceDoc(result.doc);
    resetPcb();
    frameDoc(result.doc);
    const n = result.warnings.length;
    editorMessage.value = `Imported ${file.name} from Wokwi${n === 0 ? '' : ` — ${n} note${n === 1 ? '' : 's'} in Problems`}. Drop the firmware on the board and press Run.`;
    return;
  }
  const result = parseProjectText(text);
  if (result.ok) {
    editor.replaceDoc(result.doc);
    resetPcb();
    importNotes.value = [];
    frameDoc(result.doc);
    editorMessage.value = `Opened ${file.name}.`;
  } else {
    editorMessage.value = `Could not open ${file.name}: ${result.error}`;
  }
}

/** "<n>% real time · <MHz> MHz" while running. */
function Readout() {
  const stats = simStats.value;
  if (!simRunning.value) return <span class="speed-readout">— % real time</span>;
  const mhz = Object.values(stats.mhz);
  const shown = mhz.length === 0 ? '' : ` · ${mhz.map((m) => m.toFixed(1)).join(' / ')} MHz`;
  return (
    <span class="speed-readout" title="Simulated time vs wall-clock time, and each board's executed clock">
      {Math.round(stats.ratio * 100)}% real time{shown}
    </span>
  );
}

export function Toolbar() {
  const fileInput = useRef<HTMLInputElement>(null);
  const running = simRunning.value;
  const ready = simStatus.value === 'ready';
  return (
    <header class="toolbar">
      <div class="brand">
        <span class="brand-mark">
          <ChipIcon />
        </span>
        <span class="brand-name">Benchtop</span>
      </div>
      <div class="toolbar-group" role="group" aria-label="Simulation controls">
        <button type="button" class="tool-button primary" disabled={!ready || running} onClick={run} title="Run">
          <PlayIcon />
          <span>Run</span>
        </button>
        <button type="button" class="tool-button" disabled={!running} onClick={pause} title="Pause">
          <PauseIcon />
        </button>
        <button type="button" class="tool-button" disabled={!ready} onClick={reset} title="Reset (restart from t = 0)">
          <ResetIcon />
        </button>
        <select
          class="tool-select"
          aria-label="Speed"
          title="Simulation speed"
          value={String(speed.value)}
          onChange={(event) => setSpeed(Number((event.target as HTMLSelectElement).value))}
        >
          {SPEEDS.map((s) => (
            <option key={s.label} value={String(s.value)}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div class="toolbar-group" role="group" aria-label="Tools">
        {testRecording.value ? (
          <button type="button" class="tool-button recording" onClick={stopRecording} title="Stop recording: choose what the test expects and download it">
            <StopIcon />
            <span>Stop</span>
          </button>
        ) : (
          <button
            type="button"
            class="tool-button"
            disabled={!ready}
            onClick={recordTest}
            title="Record a test: restart from t = 0, then every button, knob and serial input is recorded for the headless runner"
          >
            <RecordIcon />
            <span>Record test</span>
          </button>
        )}
        <button
          type="button"
          class={`tool-button${probeMode.value ? ' active' : ''}`}
          aria-pressed={probeMode.value}
          onClick={() => (probeMode.value = !probeMode.value)}
          title="Probe tool: click pins to record them in the Logic analyzer (Esc to leave)"
        >
          <ProbeIcon />
          <span>Probe</span>
        </button>
      </div>
      <div class="toolbar-group view-switch" role="group" aria-label="View">
        <button type="button" class={`tool-button${viewMode.value === 'bench' ? ' active' : ''}`} aria-pressed={viewMode.value === 'bench'} onClick={() => (viewMode.value = 'bench')} title="The bench: parts, breadboards, wires, simulation">
          Bench
        </button>
        <button type="button" class={`tool-button${viewMode.value === 'pcb' ? ' active' : ''}`} aria-pressed={viewMode.value === 'pcb'} onClick={() => (viewMode.value = 'pcb')} title="The bench's circuit as a PCB: lay it out, route it, export it">
          PCB
        </button>
      </div>
      <div class="toolbar-group" role="group" aria-label="Project">
        <button
          type="button"
          class="tool-button"
          onClick={() => {
            editor.replaceDoc(emptyProject('Untitled'));
            resetPcb();
            importNotes.value = [];
          }}
          title="New empty bench (undoable)"
        >
          New
        </button>
        <button type="button" class="tool-button" onClick={() => fileInput.current?.click()} title="Open a Benchtop project or PCB layout, or import a Wokwi diagram.json">
          Open…
        </button>
        <ExportMenu />
        <button type="button" class="tool-button" onClick={() => (galleryOpen.value = true)} title="Ready-to-run example circuits">
          Examples…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const input = event.target as HTMLInputElement;
            const file = input.files?.[0];
            input.value = '';
            if (file !== undefined) void importProject(file);
          }}
        />
      </div>
      <div class="toolbar-spacer" />
      <button type="button" class="tool-button" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => (shortcutsOpen.value = true)}>
        ?
      </button>
      <button
        type="button"
        class="tool-button"
        aria-pressed={!muted.value}
        title={muted.value ? 'Sound off — click to hear buzzers' : 'Sound on'}
        onClick={toggleMute}
      >
        {muted.value ? <SpeakerOffIcon /> : <SpeakerIcon />}
      </button>
      <Readout />
    </header>
  );
}
