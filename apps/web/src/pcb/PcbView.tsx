/**
 * The PCB view (BT59): the bench's circuit as a two-layer board, drawn in SVG under a camera
 * like the bench's (world mm, wheel to pan, ⌘/Ctrl + wheel to zoom). Select tool: click or drag
 * a footprint (snapped to 25 mil, Alt for free), click a trace or via, R rotates, Delete removes
 * traces and vias. Trace tool (X): click a pad to start, click bends (straight then 45°), V for
 * a via and the other layer, click a pad to finish (or double-click to end where it is); L
 * switches the active layer. The ratsnest shows what is left to route; DRC markers show the
 * check's findings, listed in the Problems tab. All the PCB logic is @benchtop/pcb and
 * pcb/store.ts; this only draws and turns pointer and keys into commands.
 */

import { footprintSilk, type Layer, type PcbBoard, type PcbDoc, type Point } from '@benchtop/pcb';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { editor } from '../editor/app-store.ts';
import { type Camera, DEFAULT_CAMERA, fitRect, pan, PX_PER_MM, screenToWorld, zoomAt } from '../editor/camera.ts';
import { matchPcbShortcut, matchShortcut, shortcutsOpen } from '../editor/shortcuts.ts';
import { pcbBoard, pcbCheck, pcbEditor } from './app-pcb.ts';
import { drcViolations, pcbFocus } from './mode.ts';
import { backUp, extend, finishRoute, type Route, snapPoint, startRoute, switchLayer } from './route.ts';

const COLORS = {
  board: '#1d4d34',
  edge: '#e7d37a',
  F: '#d8574b',
  B: '#3f7fd6',
  pad: '#c9a227',
  via: '#aeb8c2',
  hole: '#0b1016',
  silk: '#f0f0f0',
  rats: 'rgba(255, 255, 255, 0.55)',
  drc: '#ff4d4d',
  select: '#2fbf86',
};

/** Pointer slop for clicking thin things, screen px. */
const PICK_PX = 6;

interface DragState {
  kind: 'move' | 'pan';
  start: Point;
  /** Screen point where the pointer went down. */
  screen: Point;
  parts: string[];
  moved: boolean;
  offset: Point;
}

function boardBox(pcb: PcbDoc, board: PcbBoard): { x: number; y: number; w: number; h: number } {
  const xs = [...pcb.outline.map((p) => p.x), ...board.placed.flatMap((f) => [f.courtyard.x0, f.courtyard.x1])];
  const ys = [...pcb.outline.map((p) => p.y), ...board.placed.flatMap((f) => [f.courtyard.y0, f.courtyard.y1])];
  if (xs.length === 0) return { x: 0, y: 0, w: 100, h: 80 };
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const pathOf = (points: readonly Point[]): string => points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');

export function PcbView() {
  const project = editor.doc.value;
  const pcb = pcbEditor.doc.value;
  const selection = pcbEditor.selection.value;
  const tool = pcbEditor.tool.value;
  const layer = pcbEditor.layer.value;
  const viewport = useRef<HTMLElement>(null);
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA);
  const [route, setRouteState] = useState<Route | null>(null);
  // Handlers read the route through a ref set at once, not the last render's value: a key or a
  // click can arrive before the re-render that would hand them the new route.
  const routeRef = useRef<Route | null>(null);
  const setRoute = (next: Route | null): void => {
    routeRef.current = next;
    setRouteState(next);
  };
  const [cursor, setCursor] = useState<Point | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const framed = useRef(false);

  // The PCB follows the bench: seeded the first time, reconciled after bench edits.
  useEffect(() => pcbEditor.sync(project), [project]);

  const board = pcbBoard.value;
  const check = pcbCheck.value;
  const silk = useMemo(() => (board === null ? null : new Map(board.placed.map((f) => [f.doc.part, footprintSilk(f)]))), [board]);
  const derived = check === null || silk === null ? null : { ...check, silk };
  // The Problems tab's badge counts the findings while the PCB is shown.
  useEffect(() => {
    drcViolations.value = check?.result.violations.length ?? 0;
  }, [check]);

  const fit = (): void => {
    const vp = viewport.current;
    if (vp === null || pcb === null || board === null) return;
    setCamera(fitRect(boardBox(pcb, board), vp.clientWidth, vp.clientHeight, 48, 8));
  };
  useEffect(() => {
    if (!framed.current && board !== null) {
      framed.current = true;
      fit();
    }
  }, [board]);

  // A DRC row clicked in the Problems tab: centre on it.
  const focus = pcbFocus.value;
  useEffect(() => {
    const vp = viewport.current;
    if (focus === null || vp === null) return;
    const s = PX_PER_MM * camera.zoom;
    setCamera({ x: vp.clientWidth / 2 - focus.x * s, y: vp.clientHeight / 2 - focus.y * s, zoom: camera.zoom });
    pcbFocus.value = null;
  }, [focus]);

  const toWorld = (event: { clientX: number; clientY: number }): Point => {
    const r = viewport.current!.getBoundingClientRect();
    return screenToWorld(camera, { x: event.clientX - r.left, y: event.clientY - r.top });
  };
  const pick = PICK_PX / (PX_PER_MM * camera.zoom);

  const padAt = (p: Point): { x: number; y: number } | null => {
    if (board === null) return null;
    for (const pad of board.pads) if (Math.abs(p.x - pad.x) <= pad.w / 2 + pick / 2 && Math.abs(p.y - pad.y) <= pad.h / 2 + pick / 2) return pad;
    for (const via of pcb?.vias ?? []) if (Math.hypot(p.x - via.x, p.y - via.y) <= via.diameter / 2 + pick / 2) return via;
    return null;
  };
  const itemAt = (p: Point): string | null => {
    if (pcb === null || board === null) return null;
    for (const via of pcb.vias) if (Math.hypot(p.x - via.x, p.y - via.y) <= via.diameter / 2 + pick) return `via:${via.id}`;
    // The active layer's traces first.
    const traces = [...pcb.traces].sort((a, b) => Number(a.layer !== layer) - Number(b.layer !== layer));
    for (const t of traces) for (let i = 0; i + 1 < t.points.length; i++) if (segmentDistance(p, t.points[i], t.points[i + 1]) <= t.width / 2 + pick) return `tr:${t.id}`;
    let best: { key: string; area: number } | null = null;
    for (const f of board.placed) {
      const c = f.courtyard;
      if (p.x < c.x0 || p.x > c.x1 || p.y < c.y0 || p.y > c.y1) continue;
      const area = (c.x1 - c.x0) * (c.y1 - c.y0);
      if (best === null || area < best.area) best = { key: `fp:${f.doc.part}`, area };
    }
    return best?.key ?? null;
  };

  const select = (key: string | null, add: boolean): void => {
    if (key === null) {
      if (!add) pcbEditor.selection.value = new Set();
      return;
    }
    const next = new Set(add ? pcbEditor.selection.peek() : []);
    if (add && next.has(key)) next.delete(key);
    else next.add(key);
    pcbEditor.selection.value = next;
  };

  const endRoute = (r: Route): void => {
    const done = finishRoute(r);
    pcbEditor.addRoute(done.traces, done.vias);
    setRoute(null);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (pcb === null) return;
    viewport.current?.focus();
    const at = toWorld(event);
    const r = viewport.current!.getBoundingClientRect();
    const screen = { x: event.clientX - r.left, y: event.clientY - r.top };
    if (event.button === 1) {
      setDrag({ kind: 'pan', start: at, screen, parts: [], moved: false, offset: { x: 0, y: 0 } });
      (event.target as Element).setPointerCapture?.(event.pointerId);
      return;
    }
    if (pcbEditor.tool.peek() === 'route') {
      const pad = padAt(at);
      const current = routeRef.current;
      if (current === null) {
        if (pad !== null) setRoute(startRoute({ x: pad.x, y: pad.y }, pcbEditor.layer.peek(), pcbEditor.width.peek()));
        return;
      }
      if (pad !== null) endRoute(extend(current, { x: pad.x, y: pad.y }));
      else setRoute(extend(current, event.altKey ? at : snapPoint(at)));
      return;
    }
    const key = itemAt(at);
    if (key === null) {
      if (!event.shiftKey) select(null, false);
      setDrag({ kind: 'pan', start: at, screen, parts: [], moved: false, offset: { x: 0, y: 0 } });
    } else {
      if (!selection.has(key) || event.shiftKey) select(key, event.shiftKey);
      const sel = selection.has(key) && !event.shiftKey ? selection : new Set([...(event.shiftKey ? selection : []), key]);
      const parts = [...sel].filter((k) => k.startsWith('fp:')).map((k) => k.slice(3));
      if (key.startsWith('fp:')) setDrag({ kind: 'move', start: at, screen, parts, moved: false, offset: { x: 0, y: 0 } });
    }
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (viewport.current === null) return;
    const at = toWorld(event);
    if (tool === 'route') setCursor(event.altKey ? at : snapPoint(at));
    if (drag === null) return;
    const r = viewport.current.getBoundingClientRect();
    const screen = { x: event.clientX - r.left, y: event.clientY - r.top };
    if (drag.kind === 'pan') {
      setCamera((c) => pan(c, screen.x - drag.screen.x, screen.y - drag.screen.y));
      setDrag({ ...drag, screen, moved: true });
      return;
    }
    const raw = { x: at.x - drag.start.x, y: at.y - drag.start.y };
    const offset = event.altKey ? raw : snapPoint(raw);
    setDrag({ ...drag, moved: drag.moved || Math.hypot(raw.x, raw.y) > pick, offset });
  };

  const onPointerUp = (): void => {
    if (drag?.kind === 'move' && drag.moved) pcbEditor.moveFootprints(drag.parts, drag.offset.x, drag.offset.y);
    setDrag(null);
  };

  const onDoubleClick = (): void => {
    if (routeRef.current !== null) endRoute(routeRef.current);
  };

  // Wheel: pan, or zoom with ⌘/Ctrl (and pinch).
  useEffect(() => {
    const vp = viewport.current;
    if (vp === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const r = vp.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) setCamera((c) => zoomAt(c, { x: event.clientX - r.left, y: event.clientY - r.top }, Math.exp(-event.deltaY * 0.0025)));
      else setCamera((c) => pan(c, -event.deltaX, -event.deltaY));
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, []);

  // Keys, while the PCB view is shown.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      const via = { drill: pcbEditor.doc.peek()?.rules.viaDrill ?? 0.4, diameter: pcbEditor.doc.peek()?.rules.viaDiameter ?? 0.8 };
      const route = routeRef.current;
      switch (matchPcbShortcut(event)) {
        case 'pcb-route':
          pcbEditor.tool.value = pcbEditor.tool.peek() === 'route' ? 'select' : 'route';
          setRoute(null);
          return;
        case 'pcb-layer':
        case 'pcb-via':
          if (route !== null) {
            const next = switchLayer(route, via);
            setRoute(next);
            pcbEditor.layer.value = next.layer;
          } else if (matchPcbShortcut(event) === 'pcb-layer') pcbEditor.layer.value = pcbEditor.layer.peek() === 'F' ? 'B' : 'F';
          return;
        default:
          break;
      }
      switch (matchShortcut(event)) {
        case 'escape':
          if (route !== null) setRoute(null);
          else if (shortcutsOpen.value) shortcutsOpen.value = false;
          else if (pcbEditor.tool.peek() === 'route') pcbEditor.tool.value = 'select';
          else pcbEditor.selection.value = new Set();
          break;
        case 'delete':
          event.preventDefault();
          if (route !== null) setRoute(backUp(route));
          else pcbEditor.deleteSelection();
          break;
        case 'undo':
          event.preventDefault();
          pcbEditor.undo();
          break;
        case 'redo':
          event.preventDefault();
          pcbEditor.redo();
          break;
        case 'rotate':
          pcbEditor.rotateFootprints([...pcbEditor.selection.peek()].filter((k) => k.startsWith('fp:')).map((k) => k.slice(3)));
          break;
        case 'fit':
          fit();
          break;
        case 'help':
          shortcutsOpen.value = !shortcutsOpen.value;
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [board]);

  if (pcb === null || board === null || derived === null) return <main class="pcb-view" ref={viewport} />;

  const s = PX_PER_MM * camera.zoom;
  const moving = drag?.kind === 'move' && drag.moved ? new Set(drag.parts) : new Set<string>();
  const shift = (part: string): Point => (moving.has(part) ? drag!.offset : { x: 0, y: 0 });
  const errors = derived.result.violations.filter((v) => v.severity === 'error').length;
  const warnings = derived.result.violations.length - errors;
  const layers: Layer[] = layer === 'F' ? ['B', 'F'] : ['F', 'B'];
  const preview = route === null || cursor === null ? null : extend(route, cursor);

  return (
    <main
      class={`pcb-view${tool === 'route' ? ' routing' : ''}${drag?.kind === 'pan' ? ' panning' : ''}`}
      ref={viewport}
      tabIndex={0}
      aria-label="PCB layout"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDblClick={onDoubleClick}
    >
      <svg class="pcb-svg" width="100%" height="100%">
        <g transform={`translate(${camera.x} ${camera.y}) scale(${s})`}>
          {pcb.outline.length >= 3 && <path d={`${pathOf(pcb.outline)} Z`} fill={COLORS.board} stroke={COLORS.edge} stroke-width={0.15} />}
          {layers.map((l) => (
            <g key={l} opacity={l === layer ? 0.95 : 0.55}>
              {pcb.traces
                .filter((t) => t.layer === l)
                .map((t) => (
                  <path
                    key={t.id}
                    d={pathOf(t.points)}
                    fill="none"
                    stroke={selection.has(`tr:${t.id}`) ? COLORS.select : COLORS[l]}
                    stroke-width={t.width}
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                ))}
            </g>
          ))}
          {board.pads.map((p) => {
            const o = shift(p.part);
            const x = p.x + o.x;
            const y = p.y + o.y;
            const fill = COLORS.pad;
            return (
              <g key={`${p.ref}:${p.pin}`}>
                {p.shape === 'rect' ? (
                  <rect x={x - p.w / 2} y={y - p.h / 2} width={p.w} height={p.h} fill={fill} />
                ) : (
                  <rect x={x - p.w / 2} y={y - p.h / 2} width={p.w} height={p.h} rx={Math.min(p.w, p.h) / 2} fill={fill} />
                )}
                <circle cx={x} cy={y} r={p.drill / 2} fill={COLORS.hole} />
              </g>
            );
          })}
          {pcb.vias.map((v) => (
            <g key={v.id}>
              <circle cx={v.x} cy={v.y} r={v.diameter / 2} fill={selection.has(`via:${v.id}`) ? COLORS.select : COLORS.via} />
              <circle cx={v.x} cy={v.y} r={v.drill / 2} fill={COLORS.hole} />
            </g>
          ))}
          <g stroke={COLORS.silk} stroke-width={0.15} stroke-linecap="round" fill="none" opacity={0.85}>
            {board.placed.map((f) => {
              const o = shift(f.doc.part);
              return (
                <g key={f.doc.part} transform={o.x === 0 && o.y === 0 ? undefined : `translate(${o.x} ${o.y})`}>
                  {(derived.silk.get(f.doc.part) ?? []).map((line, k) => (
                    <path key={k} d={pathOf(line)} />
                  ))}
                  {selection.has(`fp:${f.doc.part}`) && (
                    <rect
                      x={f.courtyard.x0}
                      y={f.courtyard.y0}
                      width={f.courtyard.x1 - f.courtyard.x0}
                      height={f.courtyard.y1 - f.courtyard.y0}
                      stroke={COLORS.select}
                      stroke-width={0.25}
                      stroke-dasharray="1 0.6"
                    />
                  )}
                </g>
              );
            })}
          </g>
          <g stroke={COLORS.rats} stroke-width={Math.max(0.08, 1 / s)}>
            {derived.lines.map((l, k) => {
              const a = board.pads[l.a];
              const b = board.pads[l.b];
              const oa = shift(a.part);
              const ob = shift(b.part);
              return <line key={k} x1={a.x + oa.x} y1={a.y + oa.y} x2={b.x + ob.x} y2={b.y + ob.y} />;
            })}
          </g>
          <g fill="none" stroke={COLORS.drc} stroke-width={Math.max(0.12, 1.5 / s)}>
            {derived.result.violations
              .filter((v) => v.code !== 'unrouted')
              .map((v, k) => (
                <circle key={k} cx={v.at.x} cy={v.at.y} r={Math.max(0.8, 8 / s)} opacity={v.severity === 'error' ? 1 : 0.6} />
              ))}
          </g>
          {preview !== null && (
            <path d={pathOf(preview.points)} fill="none" stroke={COLORS[preview.layer]} stroke-width={preview.width} stroke-linecap="round" stroke-linejoin="round" opacity={0.7} stroke-dasharray={`${preview.width * 2} ${preview.width}`} />
          )}
          {route !== null &&
            route.vias.map((v, k) => <circle key={k} cx={v.x} cy={v.y} r={v.diameter / 2} fill={COLORS.via} opacity={0.8} />)}
        </g>
      </svg>
      <div class="pcb-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" class={`tool-button${tool === 'select' ? ' active' : ''}`} onClick={() => ((pcbEditor.tool.value = 'select'), setRoute(null))} title="Select and move (Esc)">
          Select
        </button>
        <button type="button" class={`tool-button${tool === 'route' ? ' active' : ''}`} onClick={() => (pcbEditor.tool.value = 'route')} title="Trace tool (X): click a pad, click bends, click a pad to finish">
          Route
        </button>
        <span class="pcb-sep" />
        {(['F', 'B'] as const).map((l) => (
          <button key={l} type="button" class={`tool-button layer-${l}${layer === l ? ' active' : ''}`} onClick={() => (pcbEditor.layer.value = l)} title={l === 'F' ? 'Front copper (L switches)' : 'Back copper (L switches)'}>
            {l === 'F' ? 'Front' : 'Back'}
          </button>
        ))}
        <select class="tool-select" aria-label="Trace width" title="Width of new traces" value={String(pcbEditor.width.value)} onChange={(e) => (pcbEditor.width.value = Number((e.target as HTMLSelectElement).value))}>
          {[0.25, 0.3, 0.4, 0.6, 0.8, 1.0].map((w) => (
            <option key={w} value={String(w)}>
              {w} mm
            </option>
          ))}
        </select>
        <span class="pcb-sep" />
        <button type="button" class="tool-button" onClick={() => pcbEditor.fitOutline(project)} title="Put the board outline 3 mm around every part">
          Fit outline
        </button>
        <span class={`pcb-drc ${errors > 0 ? 'bad' : warnings > 0 ? 'warn' : 'ok'}`} title="Design rule check: details in the Problems tab">
          {errors === 0 && warnings === 0 ? 'DRC clean' : `DRC: ${errors} error${errors === 1 ? '' : 's'}${warnings > 0 ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`}
          {derived.result.unrouted > 0 && ` · ${derived.result.unrouted} to route`}
        </span>
      </div>
      {board.placed.length === 0 && (
        <div class="workbench-empty">
          <div class="workbench-empty-title">Nothing to lay out</div>
          <div class="workbench-empty-body">Parts on the bench appear here as footprints; breadboards and wires become their nets.</div>
        </div>
      )}
    </main>
  );
}
