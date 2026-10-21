/**
 * The bench camera: world (mm) ↔ screen (CSS px) mapping. Pure functions on immutable values.
 * Zoom 1 is 96 dpi — the unit @wokwi/elements draws in — so 1 mm = 3.7795 px; the default is 2.
 *
 *   screen = world × PX_PER_MM × zoom + (x, y)
 */

export const PX_PER_MM = 96 / 25.4;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;
export const DEFAULT_ZOOM = 2;

export interface Camera {
  /** Screen px of the world origin. */
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const DEFAULT_CAMERA: Camera = { x: 40, y: 40, zoom: DEFAULT_ZOOM };

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** CSS px per mm at this camera's zoom. */
export function scale(camera: Camera): number {
  return PX_PER_MM * camera.zoom;
}

export function worldToScreen(camera: Camera, world: Point): Point {
  const s = scale(camera);
  return { x: world.x * s + camera.x, y: world.y * s + camera.y };
}

export function screenToWorld(camera: Camera, screen: Point): Point {
  const s = scale(camera);
  return { x: (screen.x - camera.x) / s, y: (screen.y - camera.y) / s };
}

/** Zooms by `factor` about a screen point, keeping the world point under it fixed. */
export function zoomAt(camera: Camera, screen: Point, factor: number): Camera {
  const zoom = clampZoom(camera.zoom * factor);
  if (zoom === camera.zoom) return camera;
  const world = screenToWorld(camera, screen);
  const s = PX_PER_MM * zoom;
  return { x: screen.x - world.x * s, y: screen.y - world.y * s, zoom };
}

export function pan(camera: Camera, dx: number, dy: number): Camera {
  return { x: camera.x + dx, y: camera.y + dy, zoom: camera.zoom };
}

/**
 * A camera that fits world rectangle `rect` (mm) into a `width`×`height` px viewport with
 * `margin` px around it, centered; zoom clamped and never closer than `maxZoom`.
 */
export function fitRect(rect: { x: number; y: number; w: number; h: number }, width: number, height: number, margin = 48, maxZoom = 4): Camera {
  const fit = Math.min((width - 2 * margin) / Math.max(rect.w, 1), (height - 2 * margin) / Math.max(rect.h, 1)) / PX_PER_MM;
  const zoom = clampZoom(Math.min(fit, maxZoom));
  const s = PX_PER_MM * zoom;
  return { x: width / 2 - (rect.x + rect.w / 2) * s, y: height / 2 - (rect.y + rect.h / 2) * s, zoom };
}
