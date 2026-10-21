/**
 * The environment under the parts (BT55): the faint heatmap of the room's overlay field (a
 * canvas of one pixel per cell, scaled up smoothly in world mm), and for the selected parts the
 * field of view of a sensor that samples the room and the patrol of a person or object. Drawn
 * only while the document has an environment part; never takes the pointer.
 */

import { CATALOG, envSpecFor } from '@benchtop/parts';
import type { PartInstance, ProjectDoc } from '@benchtop/core';
import { useEffect, useRef } from 'preact/hooks';
import { PX_PER_MM } from './camera.ts';
import { clearHeatmap, type Heatmap, heatmap, heatRgba, onHeatmap } from './heatmap.ts';

function paint(canvas: HTMLCanvasElement, h: Heatmap | null): void {
  if (h === null || h.w === 0 || h.h === 0) {
    canvas.hidden = true;
    return;
  }
  canvas.hidden = false;
  if (canvas.width !== h.w) canvas.width = h.w;
  if (canvas.height !== h.h) canvas.height = h.h;
  canvas.style.left = `${h.x * PX_PER_MM}px`;
  canvas.style.top = `${h.y * PX_PER_MM}px`;
  canvas.style.width = `${h.w * h.cell * PX_PER_MM}px`;
  canvas.style.height = `${h.h * h.cell * PX_PER_MM}px`;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const image = ctx.createImageData(h.w, h.h);
  for (let i = 0; i < h.bytes.length; i++) heatRgba(h.bytes[i], image.data, i * 4);
  ctx.putImageData(image, 0, 0);
}

/** A facing in a part's own frame turned with its rotation (the bench's rule). */
function turned(rotation: number, x: number, y: number): [number, number] {
  if (rotation === 90) return [-y, x];
  if (rotation === 180) return [-x, -y];
  if (rotation === 270) return [y, -x];
  return [x, y];
}

/** SVG path of a sensor's cone (bench mm), or null for a part without one. */
function conePath(part: PartInstance, scale: number): string | null {
  const def = CATALOG.get(part.type);
  if (def === undefined) return null;
  const spec = envSpecFor(part.type, { ...def.defaults, ...part.props });
  if (spec?.role !== 'sensor' || spec.cone === undefined) return null;
  const cx = part.x + def.size.w / 2;
  const cy = part.y + def.size.h / 2;
  const [fx, fy] = turned(part.rotation, spec.cone.facing?.x ?? 0, spec.cone.facing?.y ?? -1);
  const r = (spec.cone.range * 1000) / scale;
  const half = (spec.cone.halfAngleDeg * Math.PI) / 180;
  const ray = (a: number): [number, number] => [cx + r * (fx * Math.cos(a) - fy * Math.sin(a)), cy + r * (fx * Math.sin(a) + fy * Math.cos(a))];
  const [ax, ay] = ray(-half);
  const [bx, by] = ray(half);
  return `M${cx} ${cy} L${ax} ${ay} A${r} ${r} 0 0 1 ${bx} ${by} Z`;
}

/** Line of a body's patrol (bench mm), or null. */
function patrolPath(part: PartInstance): string | null {
  if (part.type !== 'person' && part.type !== 'object') return null;
  const def = CATALOG.get(part.type);
  if (def === undefined) return null;
  const props = { ...def.defaults, ...part.props };
  const toX = Number(props.toX) || 0;
  const toY = Number(props.toY) || 0;
  if (toX === 0 && toY === 0) return null;
  const cx = part.x + def.size.w / 2;
  const cy = part.y + def.size.h / 2;
  return `M${cx} ${cy} l${toX} ${toY}`;
}

export function EnvironmentLayer({ doc, selection }: { doc: ProjectDoc; selection: ReadonlySet<string> }) {
  const room = doc.parts.find((p) => p.type === 'environment');
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (room === undefined) {
      clearHeatmap();
      return;
    }
    const c = canvas.current;
    if (c === null) return;
    paint(c, heatmap());
    return onHeatmap((h) => paint(c, h));
  }, [room === undefined]);

  if (room === undefined) return null;
  const def = CATALOG.get('environment');
  const scale = Number(room.props.scale ?? def?.defaults.scale ?? 10) || 10;
  const shapes = doc.parts
    .filter((p) => selection.has(p.id))
    .flatMap((p) => [conePath(p, scale), patrolPath(p)].filter((d): d is string => d !== null).map((d, i) => ({ key: `${p.id}:${i}`, d, patrol: p.type === 'person' || p.type === 'object' })));
  return (
    <>
      <canvas class="env-heatmap" ref={canvas} hidden />
      {shapes.length > 0 && (
        <svg class="env-guides" width="1" height="1" aria-hidden="true">
          <g transform={`scale(${PX_PER_MM})`}>
            {shapes.map((s) => (
              <path key={s.key} d={s.d} class={s.patrol ? 'env-patrol' : 'env-cone'} />
            ))}
          </g>
        </svg>
      )}
    </>
  );
}
