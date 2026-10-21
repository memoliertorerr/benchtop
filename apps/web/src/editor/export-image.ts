/**
 * The bench as an image (BT40), with no dependency: an SVG built from what the canvas shows —
 * each part's own SVG (a wokwi element's shadow-DOM SVG, the breadboard's SVG) cloned into place
 * at the part's position and rotation, with the shadow roots' stylesheets inlined, and the
 * wires drawn from the document as the wire layer draws them — and a PNG drawn from that SVG on
 * a canvas at 2×. A part's canvas (the SSD1306's pixels) becomes an <image> of its current
 * pixels (a data URL, so the PNG's canvas isn't tainted).
 */

import type { ProjectDoc } from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';
import { PX_PER_MM } from './camera.ts';
import { docBounds } from './frame.ts';
import { pathData } from './routing.ts';
import { wireRoute } from './Wires.tsx';
import { WIRE_SHADES } from './wiring.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARGIN_MM = 4;

/** The SVG a part's element draws with, wherever its view keeps it. */
function partSvg(wrapper: Element): SVGSVGElement | null {
  const element = wrapper.firstElementChild;
  if (element === null) return null;
  const shadow = (element as HTMLElement).shadowRoot;
  const svg = shadow?.querySelector('svg') ?? element.querySelector('svg') ?? (element instanceof SVGSVGElement ? element : null);
  return svg as SVGSVGElement | null;
}

/** The CSS a shadow root's SVG relies on (lit's adopted sheets and <style> children). */
function shadowCss(wrapper: Element): string {
  const shadow = (wrapper.firstElementChild as HTMLElement | null)?.shadowRoot;
  if (shadow === null || shadow === undefined) return '';
  const rules: string[] = [];
  for (const sheet of shadow.adoptedStyleSheets ?? []) for (const rule of Array.from(sheet.cssRules)) rules.push(rule.cssText);
  for (const style of Array.from(shadow.querySelectorAll('style'))) rules.push(style.textContent ?? '');
  return rules.join('\n');
}

/** A canvas's pixels as an SVG <image> at the given box (in the part SVG's user units). */
function canvasImage(canvas: HTMLCanvasElement, box: { x: number; y: number; w: number; h: number }): SVGImageElement {
  const image = document.createElementNS(SVG_NS, 'image');
  image.setAttribute('x', String(box.x));
  image.setAttribute('y', String(box.y));
  image.setAttribute('width', String(box.w));
  image.setAttribute('height', String(box.h));
  image.setAttribute('href', canvas.toDataURL('image/png'));
  image.setAttribute('preserveAspectRatio', 'none');
  const style = getComputedStyle(canvas);
  if (style.imageRendering === 'pixelated') image.setAttribute('style', 'image-rendering: pixelated');
  if (style.opacity !== '1') image.setAttribute('opacity', style.opacity);
  return image;
}

/**
 * Brings canvases into the cloned SVG as images of their current pixels: one inside a
 * foreignObject takes the foreignObject's place; one laid over the SVG by CSS (the wokwi
 * SSD1306 positions its canvas absolutely in the SVG's container) is added at its offset.
 * Other foreignObjects (HTML the SVG can't carry standalone) are dropped.
 */
function flattenCanvases(original: SVGSVGElement, clone: SVGSVGElement): void {
  const sources = Array.from(original.querySelectorAll('foreignObject'));
  const targets = Array.from(clone.querySelectorAll('foreignObject'));
  sources.forEach((source, i) => {
    const target = targets[i];
    if (target === undefined) return;
    const canvas = source.querySelector('canvas');
    const box = (name: string) => Number(source.getAttribute(name) ?? 0);
    if (canvas === null) target.remove();
    else target.replaceWith(canvasImage(canvas, { x: box('x'), y: box('y'), w: box('width'), h: box('height') }));
  });
  const container = original.parentElement;
  if (container === null) return;
  const viewBox = original.viewBox.baseVal;
  const hasViewBox = original.hasAttribute('viewBox') && viewBox.width > 0 && original.clientWidth > 0;
  const sx = hasViewBox ? viewBox.width / original.clientWidth : 1;
  const sy = hasViewBox ? viewBox.height / original.clientHeight : 1;
  const ox = hasViewBox ? viewBox.x : 0;
  const oy = hasViewBox ? viewBox.y : 0;
  for (const canvas of Array.from(container.querySelectorAll('canvas'))) {
    if (canvas.closest('foreignObject') !== null || canvas.offsetParent !== container || canvas.offsetWidth === 0) continue;
    clone.append(canvasImage(canvas, { x: ox + canvas.offsetLeft * sx, y: oy + canvas.offsetTop * sy, w: canvas.offsetWidth * sx, h: canvas.offsetHeight * sy }));
  }
}

/** The bench (`doc`, drawn in `world`, the canvas's world layer) as an SVG document string. */
export function benchSvg(doc: ProjectDoc, world: HTMLElement, background: string): string {
  const bounds = docBounds(doc) ?? { x: 0, y: 0, w: 10, h: 10 };
  const x0 = bounds.x - MARGIN_MM;
  const y0 = bounds.y - MARGIN_MM;
  const w = bounds.w + 2 * MARGIN_MM;
  const h = bounds.h + 2 * MARGIN_MM;
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('xmlns', SVG_NS);
  root.setAttribute('width', `${w}mm`);
  root.setAttribute('height', `${h}mm`);
  root.setAttribute('viewBox', `${x0} ${y0} ${w} ${h}`);
  const bg = document.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of Object.entries({ x: x0, y: y0, width: w, height: h })) bg.setAttribute(k, String(v));
  bg.setAttribute('fill', background);
  root.append(bg);

  const css = new Map<string, string>();
  for (const part of doc.parts) {
    const def = CATALOG.get(part.type);
    const wrapper = world.querySelector(`[data-part-id="${CSS.escape(part.id)}"]`);
    const svg = wrapper === null ? null : partSvg(wrapper);
    if (def === undefined || wrapper === null || svg === null) continue;
    if (!css.has(part.type)) css.set(part.type, shadowCss(wrapper));
    const clone = svg.cloneNode(true) as SVGSVGElement;
    flattenCanvases(svg, clone);
    // The SVG sits at the wrapper's top-left at its natural size, as on the canvas.
    const element = wrapper.firstElementChild as HTMLElement;
    const widthPx = svg.clientWidth || element.offsetWidth;
    const heightPx = svg.clientHeight || element.offsetHeight;
    if (!clone.hasAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${widthPx} ${heightPx}`);
    clone.setAttribute('x', String(part.x));
    clone.setAttribute('y', String(part.y));
    clone.setAttribute('width', String(widthPx / PX_PER_MM));
    clone.setAttribute('height', String(heightPx / PX_PER_MM));
    clone.setAttribute('overflow', 'visible');
    const group = document.createElementNS(SVG_NS, 'g');
    if (part.rotation !== 0) group.setAttribute('transform', `rotate(${part.rotation} ${part.x + def.size.w / 2} ${part.y + def.size.h / 2})`);
    group.append(clone);
    root.append(group);
  }
  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = [...css.values()].join('\n');
  root.insertBefore(style, bg);

  // Wires, as the wire layer draws them (outline, colored core, end dots).
  for (const wire of doc.wires) {
    const route = wireRoute(doc, wire);
    if (route === undefined) continue;
    const d = pathData(route);
    const color = WIRE_SHADES[wire.color] ?? wire.color;
    for (const [stroke, width] of [
      ['rgb(0 0 0 / 0.45)', 0.85],
      [color, 0.55],
    ] as const) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', stroke);
      path.setAttribute('stroke-width', String(width));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      root.append(path);
    }
    for (const p of [route[0], route[route.length - 1]]) {
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', String(p.x));
      dot.setAttribute('cy', String(p.y));
      dot.setAttribute('r', '0.55');
      dot.setAttribute('fill', color);
      root.append(dot);
    }
  }
  return new XMLSerializer().serializeToString(root);
}

/** The SVG drawn on a canvas at `scale`× its CSS-pixel size, as a PNG blob. */
export async function svgToPng(svg: string, widthMm: number, heightMm: number, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(widthMm * PX_PER_MM * scale);
    canvas.height = Math.ceil(heightMm * PX_PER_MM * scale);
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('no 2D canvas');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b === null ? reject(new Error('PNG encoding failed')) : resolve(b)), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The exported image's size in mm (the document's bounds plus the margin). */
export function imageSizeMm(doc: ProjectDoc): { w: number; h: number } {
  const b = docBounds(doc) ?? { x: 0, y: 0, w: 10, h: 10 };
  return { w: b.w + 2 * MARGIN_MM, h: b.h + 2 * MARGIN_MM };
}
