/**
 * The Logic analyzer tab: one row per probe (label, color, remove ×) beside one
 * devicePixelRatio-aware canvas, redrawn on requestAnimationFrame only when data or the view
 * changed. Wheel zooms around the pointer (while following, it changes the span and the newest
 * data stays at the right edge), drag pans, double-click fits everything, "Follow" keeps the
 * newest data in view. Click sets cursor A, shift-click cursor B; both snap to an edge within
 * 6 px on the row clicked.
 */

import { LEVEL_X, LEVEL_Z, writeVcd } from '@benchtop/core';
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { editor } from '../../editor/app-store.ts';
import { decimate, edgeAt } from './decimate.ts';
import { captures, clearCaptures, latestTime, onCapture, probeMode, type ProbeDef, probes, removeProbe, vcdSignals } from './probes.ts';
import { formatFrequency, formatTime, niceStep } from './units.ts';

const AXIS_H = 22;
const ROW_H = 30;
const SNAP_PX = 6;
const MIN_SPAN = 50; // ns
const MAX_SPAN = 1e12; // ns (1000 s)

const follow = signal(true);
const cursorA = signal<number | null>(null);
const cursorB = signal<number | null>(null);
/** The visible window: [t0, t0 + span] ns. While following, t0 tracks the newest data. */
const view = { t0: 0, span: 10e6 };
let requestDraw = (): void => {};

function windowNow(): { t0: number; t1: number } {
  if (follow.peek()) view.t0 = Math.max(0, latestTime - view.span);
  return { t0: view.t0, t1: view.t0 + view.span };
}

function fitAll(): void {
  let earliest = latestTime;
  for (const { ring } of captures.values()) if (ring.size > 0) earliest = Math.min(earliest, ring.timeAt(ring.first));
  view.t0 = earliest;
  view.span = Math.max(MIN_SPAN * 20, latestTime - earliest);
  follow.value = false;
  requestDraw();
}

function exportVcd(): void {
  const text = writeVcd(vcdSignals(), new Date().toUTCString());
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const name = editor.doc.peek().name.replace(/[^\w.-]+/g, '-') || 'bench';
  link.download = `benchtop-${name}-${formatTime(latestTime).replace(/\s+/g, '').replace('µ', 'u')}.vcd`;
  link.click();
  URL.revokeObjectURL(url);
}

let hatchCache: { key: string; pattern: CanvasPattern | null } | null = null;

/** A small diagonal hatch for conflict (x) spans (made once per color and pixel ratio). */
function hatch(ctx: CanvasRenderingContext2D, color: string, dpr: number): CanvasPattern | null {
  const key = `${color}@${dpr}`;
  if (hatchCache?.key === key) return hatchCache.pattern;
  const size = Math.round(6 * dpr);
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const t = tile.getContext('2d');
  if (t === null) return null;
  t.strokeStyle = color;
  t.lineWidth = dpr;
  t.beginPath();
  t.moveTo(0, size);
  t.lineTo(size, 0);
  t.stroke();
  hatchCache = { key, pattern: ctx.createPattern(tile, 'repeat') };
  return hatchCache.pattern;
}

function draw(canvas: HTMLCanvasElement, list: readonly ProbeDef[]): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const style = getComputedStyle(canvas);
  const muted = style.getPropertyValue('--text-muted').trim() || '#7f90a1';
  const border = style.getPropertyValue('--border').trim() || '#1e2a36';
  const danger = style.getPropertyValue('--danger').trim() || '#ef5d5d';
  ctx.clearRect(0, 0, width, height);
  const { t0, t1 } = windowNow();
  const perPx = (t1 - t0) / width;
  const xAt = (t: number): number => (t - t0) / perPx;

  // Time axis.
  ctx.font = `${11 * dpr}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = muted;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  const step = niceStep(t1 - t0, Math.max(2, Math.floor(canvas.clientWidth / 110)));
  ctx.beginPath();
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const x = Math.round(xAt(t)) + 0.5;
    ctx.moveTo(x, AXIS_H * dpr * 0.6);
    ctx.lineTo(x, height);
    ctx.fillText(formatTime(t), x + 3 * dpr, AXIS_H * dpr * 0.35);
  }
  ctx.globalAlpha = 0.5;
  ctx.stroke();
  ctx.globalAlpha = 1;

  const pattern = hatch(ctx, danger, dpr);
  list.forEach((probe, row) => {
    const top = (AXIS_H + row * ROW_H) * dpr;
    const hi = top + 7 * dpr;
    const lo = top + (ROW_H - 7) * dpr;
    const mid = (hi + lo) / 2;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top + ROW_H * dpr - 0.5);
    ctx.lineTo(width, top + ROW_H * dpr - 0.5);
    ctx.stroke();
    const capture = captures.get(probe.key);
    const note = (text: string): void => {
      ctx.fillStyle = muted;
      ctx.fillText(text, 8 * dpr, mid);
    };
    if (capture === undefined || capture.ring.size === 0) {
      note(editor.doc.peek().parts.some((p) => p.id === probe.pin.part) ? 'no data yet — run the bench' : 'not on this bench');
      return;
    }
    const segments = decimate(capture.ring, t0, t1, width, latestTime);
    ctx.strokeStyle = probe.color;
    ctx.fillStyle = probe.color;
    ctx.lineWidth = 1.5 * dpr;
    let previous = -2;
    for (const s of segments) {
      const x0 = s.x0;
      const x1 = s.x1;
      if (s.level === -1) {
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x0, hi, x1 - x0, lo - hi);
        ctx.globalAlpha = 1;
      } else if (s.level === LEVEL_X) {
        ctx.fillStyle = pattern ?? danger;
        ctx.fillRect(x0, hi, x1 - x0, lo - hi);
        ctx.fillStyle = probe.color;
      } else {
        const y = s.level === 1 ? hi : s.level === 0 ? lo : mid;
        ctx.setLineDash(s.level === LEVEL_Z ? [4 * dpr, 3 * dpr] : []);
        ctx.beginPath();
        // A vertical edge where a 0/1 level follows another level.
        if (previous !== -2 && previous !== s.level && previous !== -1) {
          ctx.moveTo(x0, previous === 1 ? hi : previous === 0 ? lo : mid);
          ctx.lineTo(x0, y);
        } else {
          ctx.moveTo(x0, y);
        }
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      previous = s.level;
    }
    if (capture.peripheral) {
      ctx.fillStyle = muted;
      ctx.fillText('peripheral — waveform not simulated', 8 * dpr, top + 4 * dpr + (ROW_H * dpr) / 2);
    }
  });

  // Cursors.
  const cursors: [number | null, string, string][] = [
    [cursorA.peek(), '#ffd54f', 'A'],
    [cursorB.peek(), '#4dd0e1', 'B'],
  ];
  for (const [t, color, name] of cursors) {
    if (t === null || t < t0 || t > t1) continue;
    const x = Math.round(xAt(t)) + 0.5;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.fillText(name, x + 3 * dpr, AXIS_H * dpr * 0.8);
  }
}

/** The time under a canvas x (css px), snapped to an edge on that row when one is close. */
function timeAtPointer(canvas: HTMLCanvasElement, x: number, y: number, list: readonly ProbeDef[]): number {
  const { t0, t1 } = windowNow();
  const perCss = (t1 - t0) / canvas.clientWidth;
  const t = t0 + x * perCss;
  const row = Math.floor((y - AXIS_H) / ROW_H);
  const ring = row >= 0 && row < list.length ? captures.get(list[row].key)?.ring : undefined;
  if (ring === undefined || ring.size === 0) return t;
  const i = edgeAt(ring, t);
  let best = t;
  let bestPx = SNAP_PX;
  for (const k of [i, i + 1]) {
    if (k < ring.first || k >= ring.written) continue;
    const px = Math.abs(ring.timeAt(k) - t) / perCss;
    if (px <= bestPx) {
      bestPx = px;
      best = ring.timeAt(k);
    }
  }
  return best;
}

function Readout() {
  const a = cursorA.value;
  const b = cursorB.value;
  if (a === null && b === null) return <span class="logic-readout muted">Click: cursor A · shift-click: cursor B</span>;
  const dt = a !== null && b !== null ? Math.abs(b - a) : null;
  return (
    <span class="logic-readout">
      {a !== null && <span>A {formatTime(a, 7)}</span>}
      {b !== null && <span>B {formatTime(b, 7)}</span>}
      {dt !== null && <span>Δt {formatTime(dt)}</span>}
      {dt !== null && dt > 0 && <span>1/Δt {formatFrequency(1e9 / dt)}</span>}
    </span>
  );
}

export function LogicAnalyzer() {
  const list = probes.value;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const hasProbes = list.length > 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let frame = 0;
    const paint = (): void => {
      frame = 0;
      draw(canvas, listRef.current);
    };
    requestDraw = () => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    };
    const offCapture = onCapture(requestDraw);
    const resize = new ResizeObserver(requestDraw);
    resize.observe(canvas);

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const x = event.offsetX;
      const width = canvas.clientWidth;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        follow.value = false;
        view.t0 = Math.max(0, view.t0 + (event.deltaX * view.span) / width);
      } else {
        const { t0 } = windowNow();
        const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, view.span * Math.exp(event.deltaY * 0.0015)));
        if (!follow.peek()) {
          const at = t0 + (x / width) * view.span;
          view.t0 = Math.max(0, at - (x / width) * span);
        }
        view.span = span;
      }
      requestDraw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    let drag: { x: number; t0: number; moved: boolean; id: number } | null = null;
    let before: [number | null, number | null] = [null, null];
    let lastClick = 0;
    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      drag = { x: event.offsetX, t0: windowNow().t0, moved: false, id: event.pointerId };
    };
    const onMove = (event: PointerEvent): void => {
      if (drag === null) return;
      const dx = event.offsetX - drag.x;
      if (!drag.moved && Math.abs(dx) < 3) return;
      drag.moved = true;
      follow.value = false;
      view.t0 = Math.max(0, drag.t0 - (dx * view.span) / canvas.clientWidth);
      requestDraw();
    };
    const onUp = (event: PointerEvent): void => {
      if (drag === null) return;
      const click = !drag.moved;
      drag = null;
      if (!click) return;
      // Remember the cursors from before a click pair, so a double-click can restore them.
      if (event.timeStamp - lastClick > 500) before = [cursorA.peek(), cursorB.peek()];
      lastClick = event.timeStamp;
      const t = timeAtPointer(canvas, event.offsetX, event.offsetY, listRef.current);
      if (event.shiftKey) cursorB.value = t;
      else cursorA.value = t;
      requestDraw();
    };
    const onDouble = (): void => {
      // The double-click's own clicks moved a cursor: put it back, then fit.
      [cursorA.value, cursorB.value] = before;
      fitAll();
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDouble);
    requestDraw();
    return () => {
      cancelAnimationFrame(frame);
      requestDraw = () => {};
      offCapture();
      resize.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('dblclick', onDouble);
    };
  }, [hasProbes]);

  // A changed probe list or follow toggle is a view change.
  useEffect(() => requestDraw(), [list, follow.value]);

  const lost = list.reduce((sum, p) => sum + (captures.get(p.key)?.lost ?? 0) + (captures.get(p.key)?.ring.dropped ?? 0), 0);
  return (
    <div class="logic">
      <div class="serial-bar">
        <button type="button" class={`chip${probeMode.value ? ' active' : ''}`} onClick={() => (probeMode.value = !probeMode.value)} title="Probe tool: click pins on the bench to probe them">
          Probe tool
        </button>
        <button type="button" class={`chip${follow.value ? ' active' : ''}`} aria-pressed={follow.value} onClick={() => (follow.value = !follow.value)} title="Keep the newest data in view">
          Follow
        </button>
        <button type="button" class="chip" onClick={fitAll} title="Fit everything recorded (or double-click the waveforms)">
          Fit
        </button>
        <button type="button" class="chip" onClick={() => {
          clearCaptures();
          cursorA.value = null;
          cursorB.value = null;
        }} title="Drop the recorded edges (probes stay)">
          Clear
        </button>
        <button type="button" class="chip" disabled={list.length === 0} onClick={exportVcd} title="Download the recording as a Value Change Dump">
          Export VCD
        </button>
        <span class="serial-spacer" />
        {lost > 0 && <span class="logic-lost" title="Older edges dropped: each probe keeps the newest 131,072">{lost.toLocaleString('en-US')} edges dropped</span>}
        <Readout />
      </div>
      {list.length === 0 ? (
        <p class="muted panel-note">No probes. Pick the Probe tool, then click pins on the bench (up to 16).</p>
      ) : (
        <div class="logic-body">
          <ul class="logic-labels" style={{ paddingTop: `${AXIS_H}px` }}>
            {list.map((p) => (
              <li key={p.key} style={{ height: `${ROW_H}px` }}>
                <span class="logic-swatch" style={{ background: p.color }} />
                <span class="logic-name" title={p.key}>
                  {p.key}
                </span>
                <button type="button" class="logic-remove" title={`Remove the probe on ${p.key}`} onClick={() => removeProbe(p.key)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <canvas ref={canvasRef} class="logic-canvas" style={{ height: `${AXIS_H + list.length * ROW_H}px` }} />
        </div>
      )}
    </div>
  );
}
