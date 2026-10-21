/**
 * The Plotter tab (BT44): a board's numeric serial output as lines over the last 10 s of
 * simulated time — auto-scaled, a legend per series, Pause to hold the view. Drawn on a canvas
 * (devicePixelRatio-aware) on animation frames when new points arrive; no chart library.
 */

import { CATALOG } from '@benchtop/parts';
import { useEffect, useRef, useState } from 'preact/hooks';
import { editor } from '../../editor/app-store.ts';
import { latestTime, plotVersion, seriesOf, WINDOW_MS } from './plot-store.ts';

const COLORS = ['#2fbf86', '#f5b942', '#5aa9ff', '#ef5d5d', '#c792ea', '#4fd1c5', '#f78c6c', '#a3be8c'];

export function SerialPlotter() {
  const boards = editor.doc.value.parts.filter((p) => CATALOG.get(p.type)?.board !== undefined).map((p) => p.id);
  const [chosen, setChosen] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const board = chosen !== null && boards.includes(chosen) ? chosen : boards[0];
  const canvas = useRef<HTMLCanvasElement>(null);
  const version = plotVersion.value;
  const labels = board === undefined ? [] : [...seriesOf(board).keys()];

  useEffect(() => {
    const el = canvas.current;
    if (el === null || board === undefined || paused) return;
    const box = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.max(1, Math.round(box.width * dpr));
    el.height = Math.max(1, Math.round(box.height * dpr));
    const ctx = el.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = box.width;
    const h = box.height;
    ctx.clearRect(0, 0, w, h);
    const end = latestTime(board);
    const start = end - WINDOW_MS;
    const series = seriesOf(board);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const s of series.values()) {
      s.forEach(start, (_t, v) => {
        if (v < min) min = v;
        if (v > max) max = v;
      });
    }
    if (!Number.isFinite(min)) return;
    if (max === min) {
      max += 1;
      min -= 1;
    }
    const pad = (max - min) * 0.08;
    const top = max + pad;
    const bottom = min - pad;
    const left = 52;
    const x = (t: number): number => left + ((t - start) / WINDOW_MS) * (w - left - 8);
    const y = (v: number): number => 8 + ((top - v) / (top - bottom)) * (h - 24);
    // Axes: five value ticks, seconds along the bottom.
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgb(127 144 161)';
    ctx.strokeStyle = 'rgb(127 144 161 / 0.18)';
    ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = bottom + ((top - bottom) * k) / 4;
      const py = y(v);
      ctx.beginPath();
      ctx.moveTo(left, py);
      ctx.lineTo(w - 8, py);
      ctx.stroke();
      ctx.fillText(Number(v.toPrecision(4)).toString(), 4, py + 4);
    }
    for (let s = Math.ceil(start / 1000); s * 1000 <= end; s++) {
      ctx.fillText(`${s} s`, x(s * 1000) - 8, h - 4);
    }
    [...series.values()].forEach((s, i) => {
      ctx.strokeStyle = COLORS[i % COLORS.length];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let first = true;
      s.forEach(start, (t, v) => {
        if (first) ctx.moveTo(x(t), y(v));
        else ctx.lineTo(x(t), y(v));
        first = false;
      });
      ctx.stroke();
    });
  }, [version, board, paused]);

  if (board === undefined) return <p class="muted panel-note">Add a board to the bench to plot its serial output.</p>;
  return (
    <div class="plotter">
      <div class="plotter-bar">
        {boards.length > 1 ? (
          <select class="tool-select" aria-label="Board" value={board} onChange={(e) => setChosen((e.target as HTMLSelectElement).value)}>
            {boards.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        ) : (
          <span class="code-board">{board}</span>
        )}
        <span class="plotter-legend">
          {labels.length === 0 ? (
            <span class="muted">Print numbers, like Serial.println(value) or "a:1,b:2", and run.</span>
          ) : (
            labels.map((label, i) => (
              <span key={label} class="plotter-key">
                <span class="plotter-swatch" style={{ background: COLORS[i % COLORS.length] }} />
                {label}
              </span>
            ))
          )}
        </span>
        <span class="toolbar-spacer" />
        <label class="plotter-pause">
          <input type="checkbox" checked={paused} onChange={(e) => setPaused((e.target as HTMLInputElement).checked)} /> Pause
        </label>
      </div>
      <canvas ref={canvas} class="plotter-canvas" aria-label={`Serial plot of ${board}`} />
    </div>
  );
}
