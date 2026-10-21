/**
 * The trace tool's geometry (BT59), DOM-free: points snap to a 0.635 mm (25 mil) grid, each new
 * point is reached by at most two segments — straight, then 45° — and switching layers mid-route
 * ends the trace so far at a via and goes on from it on the other layer.
 */

import type { Layer, PcbTrace, PcbVia, Point } from '@benchtop/pcb';

/** The routing grid, mm. */
export const ROUTE_GRID = 0.635;

export const snapPoint = (p: Point, grid = ROUTE_GRID): Point => ({ x: round(Math.round(p.x / grid) * grid), y: round(Math.round(p.y / grid) * grid) });

const round = (v: number): number => Math.round(v * 1000) / 1000 + 0;

/**
 * The points that take a route from `a` to `b` in at most two segments: straight along the
 * longer axis, then a 45° diagonal for the rest. Ends with `b`; empty when a = b.
 */
export function bend(a: Point, b: Point): Point[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return [];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax === 0 || ay === 0 || Math.abs(ax - ay) < 1e-9) return [b];
  const corner = ax > ay ? { x: round(b.x - Math.sign(dx) * ay), y: a.y } : { x: a.x, y: round(b.y - Math.sign(dy) * ax) };
  return [corner, b];
}

export interface Route {
  layer: Layer;
  width: number;
  /** The trace being drawn: its points so far (the first is where it started). */
  points: Point[];
  /** Finished pieces (before each layer switch) and their vias. */
  traces: Omit<PcbTrace, 'id'>[];
  vias: Omit<PcbVia, 'id'>[];
}

export function startRoute(at: Point, layer: Layer, width: number): Route {
  return { layer, width, points: [at], traces: [], vias: [] };
}

/** Adds the bend to `to` (snapped by the caller). */
export function extend(route: Route, to: Point): Route {
  const last = route.points[route.points.length - 1];
  return { ...route, points: [...route.points, ...bend(last, to)] };
}

/** Removes the last point (never the start). */
export function backUp(route: Route): Route {
  return route.points.length > 1 ? { ...route, points: route.points.slice(0, -1) } : route;
}

/** Ends the current piece at a via on its last point and continues on the other layer. */
export function switchLayer(route: Route, via: { drill: number; diameter: number }): Route {
  const at = route.points[route.points.length - 1];
  const traces = route.points.length >= 2 ? [...route.traces, { layer: route.layer, width: route.width, points: route.points }] : route.traces;
  return {
    layer: route.layer === 'F' ? 'B' : 'F',
    width: route.width,
    points: [at],
    traces,
    vias: [...route.vias, { x: at.x, y: at.y, drill: via.drill, diameter: via.diameter }],
  };
}

/** The pieces to add when the route ends (after a final extend to its end point). */
export function finishRoute(route: Route): { traces: Omit<PcbTrace, 'id'>[]; vias: Omit<PcbVia, 'id'>[] } {
  const traces = route.points.length >= 2 ? [...route.traces, { layer: route.layer, width: route.width, points: route.points }] : route.traces;
  return { traces, vias: route.vias };
}
