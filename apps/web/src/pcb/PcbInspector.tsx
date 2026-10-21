/**
 * The Inspector in the PCB view (BT59): the selected footprint (its part, where it is), the
 * selected trace (layer, width — editable), or else the board (size, Fit outline) and its
 * design rules (editable).
 */

import type { PcbDoc } from '@benchtop/pcb';
import { editor } from '../editor/app-store.ts';
import { pcbBoard, pcbEditor } from './app-pcb.ts';

const RULES: readonly [keyof PcbDoc['rules'], string][] = [
  ['clearance', 'Clearance'],
  ['minWidth', 'Minimum width'],
  ['minDrill', 'Minimum drill'],
  ['minAnnular', 'Minimum annular ring'],
  ['edgeClearance', 'Copper to edge'],
  ['viaDrill', 'Via drill'],
  ['viaDiameter', 'Via diameter'],
];

const mm = (v: number): string => `${Number(v.toFixed(2))} mm`;

export function PcbInspector() {
  const pcb = pcbEditor.doc.value;
  const board = pcbBoard.value;
  const selection = [...pcbEditor.selection.value];
  if (pcb === null || board === null) return <aside class="inspector" aria-label="Inspector" />;
  const fp = selection.length === 1 && selection[0].startsWith('fp:') ? board.placed.find((f) => f.doc.part === selection[0].slice(3)) : undefined;
  const trace = selection.length === 1 && selection[0].startsWith('tr:') ? pcb.traces.find((t) => t.id === selection[0].slice(3)) : undefined;
  const xs = pcb.outline.map((p) => p.x);
  const ys = pcb.outline.map((p) => p.y);
  return (
    <aside class="inspector" aria-label="Inspector">
      <div class="panel-title">Inspector · PCB</div>
      {fp !== undefined && (
        <>
          <div class="inspector-heading">
            {fp.doc.ref} — {fp.def.title}
          </div>
          <dl class="inspector-facts">
            <dt>Part</dt>
            <dd>{fp.doc.part}</dd>
            <dt>Footprint</dt>
            <dd>Benchtop:{fp.footprint.name}</dd>
            <dt>Position</dt>
            <dd>
              {fp.doc.x.toFixed(2)}, {fp.doc.y.toFixed(2)} mm
            </dd>
            <dt>Rotation</dt>
            <dd>{fp.doc.rotation}° (R turns it)</dd>
            <dt>Pads</dt>
            <dd>{fp.footprint.pads.length}</dd>
          </dl>
        </>
      )}
      {trace !== undefined && (
        <>
          <div class="inspector-heading">Trace {trace.id}</div>
          <dl class="inspector-facts">
            <dt>Layer</dt>
            <dd>{trace.layer === 'F' ? 'Front copper' : 'Back copper'}</dd>
            <dt>Segments</dt>
            <dd>{trace.points.length - 1}</dd>
          </dl>
          <label class="field">
            <span class="field-label">Width (mm)</span>
            <input type="number" step="0.05" min="0.05" value={String(trace.width)} onChange={(e) => pcbEditor.setTraceWidth(trace.id, Number((e.target as HTMLInputElement).value))} />
          </label>
        </>
      )}
      {fp === undefined && trace === undefined && (
        <>
          <div class="inspector-heading">Board</div>
          <dl class="inspector-facts">
            <dt>Size</dt>
            <dd>{xs.length >= 3 ? `${mm(Math.max(...xs) - Math.min(...xs))} × ${mm(Math.max(...ys) - Math.min(...ys))}` : 'no outline'}</dd>
            <dt>Footprints</dt>
            <dd>{board.placed.length}</dd>
            <dt>Nets</dt>
            <dd>{board.routable.length} to connect</dd>
            <dt>Traces, vias</dt>
            <dd>
              {pcb.traces.length}, {pcb.vias.length}
            </dd>
          </dl>
          <button type="button" class="tool-button" onClick={() => pcbEditor.fitOutline(editor.doc.peek())}>
            Fit outline to the parts
          </button>
          <div class="field-label pcb-rules-title">Design rules (mm)</div>
          {RULES.map(([key, label]) => (
            <label key={key} class="field">
              <span class="field-label">{label}</span>
              <input type="number" step="0.05" min="0" value={String(pcb.rules[key])} onChange={(e) => pcbEditor.setRule(key, Number((e.target as HTMLInputElement).value))} />
            </label>
          ))}
          <p class="muted inspector-hint">Breadboards and jumper wires become nets; boards become their headers. X routes, V adds a via, L switches layers, R rotates.</p>
        </>
      )}
    </aside>
  );
}
