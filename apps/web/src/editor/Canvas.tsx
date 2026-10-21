/**
 * The bench canvas. One world container under a single CSS transform (translate + scale); parts
 * sit inside it at mm × PX_PER_MM with their rotation, and the wire layer (an SVG in mm) above
 * them. Panning and zooming only rewrite that transform and the grid's CSS variables; dragging
 * parts only sets their `translate` style. Preact re-renders the part list when the document or
 * selection changes (add, remove, drop, rotate, undo), never per pointer move.
 *
 * Input: ctrl/⌘ + wheel or a trackpad pinch zooms about the cursor; plain wheel and two-finger
 * scroll pan; space + drag and middle-drag pan. Drag from the palette to place; click,
 * shift-click and marquee select; drag to move (snapped to 0.1", Alt for free); R rotates,
 * Backspace/Delete deletes, ⌘/Ctrl+Z undoes, ⌘/Ctrl+Shift+Z redoes, Esc clears the selection.
 * Wires: click (or drag from) a pin, click empty space to add waypoints, click a pin to finish;
 * Esc cancels, Backspace removes the last waypoint. A selected wire shows draggable waypoints.
 */

import { findContacts, type PartInput, type PartInstance, type ProjectDoc } from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { liveViews } from '../sim/live-views.ts';
import { sim, simRunning } from '../sim/host.ts';
import { inputTargets } from '../views/ir-remote.ts';
import { viewFor } from '../views/registry.ts';
import { isInteractive } from '../views/wokwi.ts';
import { editor, editorMessage } from './app-store.ts';
import { attachFirmwareFile } from './firmware-actions.ts';
import { type Camera, DEFAULT_CAMERA, fitRect, pan, type Point, PX_PER_MM, scale, screenToWorld, worldToScreen, zoomAt } from './camera.ts';
import { GRID_MM, partBounds, pinWorld, snapPart, snapValue } from './geometry.ts';
import { hitPin, type PinSpot, pinSpots } from './pins.ts';
import type { EditorStore } from './store.ts';
import { viewMode } from '../pcb/mode.ts';
import { EnvironmentLayer } from './EnvironmentLayer.tsx';
import { WireLayer } from './Wires.tsx';
import { frameDoc } from './frame.ts';
import { matchShortcut, shortcutsOpen } from './shortcuts.ts';
import { probeMode, toggleProbe } from '../ui/logic/probes.ts';
import { CATALOG_PINS, defaultWireColor, drawing, dropRings, editorNetlist, hoverPin, hoverWire, waypointDrag } from './wiring.ts';

/** Drag-and-drop type for palette items. */
export const PART_MIME = 'application/x-benchtop-part';
/** Zoom in percent, for the badge. */
export const zoomPercent = signal(Math.round(DEFAULT_CAMERA.zoom * 100));
/** The world point at the center of the visible canvas (palette double-click places there). */
export let canvasCenter: () => Point = () => ({ x: 50, y: 50 });
/** Moves the camera to frame a world rectangle (mm); set while a canvas is mounted. */
export let frameWorldRect: (rect: { x: number; y: number; w: number; h: number }) => void = () => {};

type MoveGesture = {
  kind: 'move';
  from: Point;
  moved: boolean;
  snap: boolean;
  dx: number;
  dy: number;
  parts: { part: PartInstance; wrapper: HTMLElement }[];
  clickSelect: string | null;
};

type Gesture =
  | { kind: 'pan'; from: Point; camera: Camera }
  | MoveGesture
  | { kind: 'marquee'; from: Point; to: Point; additive: boolean }
  | { kind: 'wire-start'; from: Point; pin: PinSpot; moved: boolean }
  | { kind: 'waypoint'; wire: string; index: number; start: Point[] };

const DRAG_THRESHOLD_PX = 3;

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
  );
}

const snapPoint = (p: Point, snap: boolean): Point => (snap ? { x: snapValue(p.x), y: snapValue(p.y) } : p);
const same = (a: PinSpot, b: PinSpot): boolean => a.part === b.part && a.pin === b.pin;

export function Canvas({ store }: { store: EditorStore }) {
  const viewport = useRef<HTMLElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const marquee = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const camera = useRef<Camera>(DEFAULT_CAMERA);
  const gesture = useRef<Gesture | null>(null);
  const spaceDown = useRef(false);
  const doc = store.doc.value;
  const selection = store.selection.value;
  const selectedWire = store.selectedWire.value;
  const spots = useMemo(() => pinSpots(doc), [doc]);
  const netlist = useMemo(() => editorNetlist(doc), [doc]);
  // Handlers read the latest document, pins and nets through a ref.
  const latest = useRef({ doc, spots, netlist });
  latest.current = { doc, spots, netlist };

  const local = (event: { clientX: number; clientY: number }): Point => {
    const rect = viewport.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const toWorld = (screen: Point): Point => screenToWorld(camera.current, screen);
  /** Pins are grabbable within 5 screen px, at least 0.45 mm and at most 1 mm. */
  const pinRadius = (): number => Math.min(1, Math.max(0.45, 5 / scale(camera.current)));

  const showTooltip = (pin: PinSpot | null): void => {
    const tip = tooltip.current;
    if (tip === null) return;
    if (pin === null) {
      tip.hidden = true;
      return;
    }
    const at = worldToScreen(camera.current, pin);
    tip.hidden = false;
    tip.textContent = `${pin.part} · ${pin.pin} · ${pin.role}`;
    tip.style.left = `${at.x + 12}px`;
    tip.style.top = `${at.y - 28}px`;
  };

  const applyCamera = (): void => {
    const c = camera.current;
    const w = world.current;
    const vp = viewport.current;
    if (w === null || vp === null) return;
    w.style.transform = `translate(${c.x}px, ${c.y}px) scale(${c.zoom})`;
    w.style.setProperty('--zoom', String(c.zoom));
    // Below ~8 px the dots turn into noise: show every fifth one instead.
    let pitch = GRID_MM * PX_PER_MM * c.zoom;
    while (pitch < 8) pitch *= 5;
    vp.style.setProperty('--grid-pitch', `${pitch}px`);
    vp.style.backgroundPosition = `${c.x}px ${c.y}px`;
    zoomPercent.value = Math.round(c.zoom * 100);
    showTooltip(hoverPin.value);
  };

  useLayoutEffect(() => {
    applyCamera();
    canvasCenter = () => {
      const rect = viewport.current!.getBoundingClientRect();
      return screenToWorld(camera.current, { x: rect.width / 2, y: rect.height / 2 });
    };
    frameWorldRect = (target) => {
      const rect = viewport.current!.getBoundingClientRect();
      camera.current = fitRect(target, rect.width, rect.height);
      applyCamera();
    };
  }, []);

  // Wheel: non-passive so the page doesn't scroll or zoom.
  useEffect(() => {
    const vp = viewport.current!;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      let dx = event.deltaX;
      let dy = event.deltaY;
      if (event.deltaMode === 1) {
        dx *= 16;
        dy *= 16;
      }
      if (event.ctrlKey || event.metaKey) {
        const clamped = Math.max(-50, Math.min(50, dy));
        camera.current = zoomAt(camera.current, local(event), Math.exp(-clamped * 0.01));
      } else {
        camera.current = pan(camera.current, -dx, -dy);
      }
      applyCamera();
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTyping(event.target) || viewMode.peek() === 'pcb') return;
      const draft = drawing.value;
      switch (matchShortcut(event)) {
        case 'pan':
          spaceDown.current = true;
          viewport.current?.classList.add('panning');
          event.preventDefault();
          break;
        case 'escape':
          if (draft !== null) drawing.value = null;
          else if (shortcutsOpen.value) shortcutsOpen.value = false;
          else if (probeMode.value) probeMode.value = false;
          else {
            store.select([]);
            store.selectWire(null);
          }
          break;
        case 'delete':
          event.preventDefault();
          if (draft !== null) {
            if (draft.waypoints.length > 0) drawing.value = { ...draft, waypoints: draft.waypoints.slice(0, -1) };
          } else store.deleteSelection();
          break;
        case 'undo':
          event.preventDefault();
          store.undo();
          break;
        case 'redo':
          event.preventDefault();
          store.redo();
          break;
        case 'rotate':
          store.rotateParts([...store.selection.value]);
          break;
        case 'fit':
          frameDoc(store.doc.peek());
          break;
        case 'help':
          shortcutsOpen.value = !shortcutsOpen.value;
          break;
        default:
          break;
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === ' ') {
        spaceDown.current = false;
        viewport.current?.classList.remove('panning');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [store]);

  const finishWire = (to: PinSpot): void => {
    const draft = drawing.value;
    if (draft === null) return;
    drawing.value = null;
    const { doc: current, netlist: nets } = latest.current;
    const id = store.addWire(draft.from, to, draft.waypoints, defaultWireColor(current, nets, draft.from, to));
    store.selectWire(id);
  };

  /** Where the dragged parts would land, and the pins of theirs that would touch other parts there. */
  const dropTargets = (g: MoveGesture): { positions: Map<string, Point>; rings: Point[] } => {
    const positions = new Map<string, Point>();
    for (const { part } of g.parts) {
      const def = CATALOG.get(part.type);
      const target = { x: part.x + g.dx, y: part.y + g.dy };
      positions.set(part.id, def === undefined ? target : snapPart(def, part.rotation, target, g.snap));
    }
    const current = latest.current.doc;
    const moved: ProjectDoc = {
      ...current,
      parts: current.parts.map((p) => {
        const to = positions.get(p.id);
        return to === undefined ? p : { ...p, x: to.x, y: to.y };
      }),
    };
    const byId = new Map(moved.parts.map((p) => [p.id, p]));
    const rings: Point[] = [];
    for (const contact of findContacts(moved, (type) => CATALOG_PINS.geometry?.(type))) {
      const aMoving = positions.has(contact.a.part);
      if (aMoving === positions.has(contact.b.part)) continue;
      const end = aMoving ? contact.a : contact.b;
      const part = byId.get(end.part);
      const def = part && CATALOG.get(part.type);
      const pin = def?.pins.find((p) => p.name === end.pin);
      if (part && def && pin) rings.push(pinWorld(def, part, pin));
    }
    return { positions, rings };
  };

  const onPointerDown = (event: PointerEvent): void => {
    const vp = viewport.current!;
    const at = local(event);
    const target = event.target as Element;
    if (event.button === 1 || (event.button === 0 && spaceDown.current)) {
      gesture.current = { kind: 'pan', from: at, camera: camera.current };
    } else if (event.button === 0) {
      const w = toWorld(at);
      const pin = hitPin(latest.current.spots, w, pinRadius());
      const draft = drawing.value;
      // While running, buttons, knobs and switches are operated, not dragged.
      if (simRunning.value && target.closest('.part-element.interactive') !== null) return;
      const handle = target.closest<SVGElement>('[data-waypoint]');
      const wireHit = target.closest<SVGElement>('[data-wire-id]');
      if (probeMode.value && draft === null && pin !== undefined) {
        // The Probe tool: a pin click adds (or removes) a probe instead of starting a wire.
        toggleProbe(pin);
        event.preventDefault();
        return;
      }
      if (draft !== null) {
        // Drawing: a pin finishes the wire, anywhere else adds a waypoint.
        if (pin !== undefined && !same(pin, draft.from)) finishWire(pin);
        else if (pin === undefined) drawing.value = { ...draft, waypoints: [...draft.waypoints, snapPoint(w, !event.altKey)] };
        event.preventDefault();
        return;
      }
      if (handle !== null && store.selectedWire.value !== null) {
        const wire = latest.current.doc.wires.find((x) => x.id === store.selectedWire.value);
        if (wire === undefined) return;
        gesture.current = { kind: 'waypoint', wire: wire.id, index: Number(handle.dataset.waypoint), start: wire.waypoints.map((p) => ({ ...p })) };
      } else if (pin !== undefined) {
        drawing.value = { from: pin, waypoints: [], cursor: { x: pin.x, y: pin.y } };
        gesture.current = { kind: 'wire-start', from: at, pin, moved: false };
      } else if (wireHit !== null) {
        store.selectWire(wireHit.dataset.wireId ?? null);
        return;
      } else {
        const id = target.closest<HTMLElement>('[data-part-id]')?.dataset.partId;
        if (id !== undefined) {
          const selected = store.selection.value;
          let clickSelect: string | null = null;
          if (event.shiftKey) {
            const next = new Set(selected);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            store.select(next);
          } else if (!selected.has(id)) {
            store.select([id]);
          } else {
            clickSelect = id; // a click without a drag narrows the selection to this part
          }
          const ids = store.selection.value;
          const parts = latest.current.doc.parts
            .filter((p) => ids.has(p.id))
            .map((part) => ({ part, wrapper: world.current!.querySelector<HTMLElement>(`[data-part-id="${part.id}"]`)! }))
            .filter((p) => p.wrapper !== null);
          gesture.current = { kind: 'move', from: at, moved: false, snap: !event.altKey, dx: 0, dy: 0, parts, clickSelect };
        } else {
          store.selectWire(null);
          gesture.current = { kind: 'marquee', from: at, to: at, additive: event.shiftKey };
        }
      }
    } else {
      return;
    }
    try {
      vp.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone (or the event was synthetic): no capture, no harm.
    }
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    const at = local(event);
    const w = toWorld(at);
    const g = gesture.current;
    if (g === null || g.kind === 'wire-start') {
      const pin = hitPin(latest.current.spots, w, pinRadius()) ?? null;
      if (pin?.part !== hoverPin.value?.part || pin?.pin !== hoverPin.value?.pin) {
        hoverPin.value = pin;
        showTooltip(pin);
      }
      const wireId = (event.target as Element).closest<SVGElement>('[data-wire-id]')?.dataset.wireId ?? null;
      if (wireId !== hoverWire.value) hoverWire.value = wireId;
      const draft = drawing.value;
      if (draft !== null) {
        const cursor = pin !== null && !same(pin, draft.from) ? { x: pin.x, y: pin.y } : snapPoint(w, !event.altKey);
        if (cursor.x !== draft.cursor.x || cursor.y !== draft.cursor.y) drawing.value = { ...draft, cursor };
      }
    }
    if (g === null) return;
    if (g.kind === 'wire-start') {
      if (Math.hypot(at.x - g.from.x, at.y - g.from.y) >= DRAG_THRESHOLD_PX) g.moved = true;
    } else if (g.kind === 'pan') {
      camera.current = pan(g.camera, at.x - g.from.x, at.y - g.from.y);
      applyCamera();
    } else if (g.kind === 'move') {
      if (!g.moved && Math.hypot(at.x - g.from.x, at.y - g.from.y) < DRAG_THRESHOLD_PX) return;
      g.moved = true;
      g.snap = !event.altKey;
      const s = scale(camera.current);
      g.dx = (at.x - g.from.x) / s;
      g.dy = (at.y - g.from.y) / s;
      const { positions, rings } = dropTargets(g);
      for (const { part, wrapper } of g.parts) {
        const to = positions.get(part.id)!;
        wrapper.style.translate = `${(to.x - part.x) * PX_PER_MM}px ${(to.y - part.y) * PX_PER_MM}px`;
      }
      dropRings.value = rings;
    } else if (g.kind === 'waypoint') {
      const waypoints = g.start.map((p, i) => (i === g.index ? snapPoint(w, !event.altKey) : p));
      waypointDrag.value = { wire: g.wire, waypoints };
    } else {
      g.to = at;
      const box = marquee.current!;
      box.hidden = false;
      box.style.left = `${Math.min(g.from.x, at.x)}px`;
      box.style.top = `${Math.min(g.from.y, at.y)}px`;
      box.style.width = `${Math.abs(at.x - g.from.x)}px`;
      box.style.height = `${Math.abs(at.y - g.from.y)}px`;
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    const g = gesture.current;
    gesture.current = null;
    if (viewport.current?.hasPointerCapture(event.pointerId)) viewport.current.releasePointerCapture(event.pointerId);
    if (g === null) return;
    if (g.kind === 'wire-start') {
      // Dragged from a pin onto another pin: done. A plain click keeps drawing.
      const pin = hitPin(latest.current.spots, toWorld(local(event)), pinRadius());
      if (g.moved && pin !== undefined && !same(pin, g.pin)) finishWire(pin);
    } else if (g.kind === 'waypoint') {
      const preview = waypointDrag.value;
      waypointDrag.value = null;
      if (preview !== null) store.updateWire(g.wire, { waypoints: preview.waypoints });
    } else if (g.kind === 'move') {
      dropRings.value = [];
      if (g.moved) {
        // Put the wrappers where the next render will, so nothing jumps back for a frame.
        const { positions } = dropTargets(g);
        for (const { part, wrapper } of g.parts) {
          const to = positions.get(part.id)!;
          wrapper.style.left = `${to.x * PX_PER_MM}px`;
          wrapper.style.top = `${to.y * PX_PER_MM}px`;
          wrapper.style.translate = '';
        }
        store.moveParts(
          g.parts.map((p) => p.part.id),
          g.dx,
          g.dy,
          g.snap,
        );
      } else if (g.clickSelect !== null) {
        store.select([g.clickSelect]);
      }
    } else if (g.kind === 'marquee') {
      marquee.current!.hidden = true;
      const a = toWorld(g.from);
      const b = toWorld(g.to);
      const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
      const hit: string[] = [];
      if (Math.hypot(g.to.x - g.from.x, g.to.y - g.from.y) >= DRAG_THRESHOLD_PX) {
        for (const part of latest.current.doc.parts) {
          const def = CATALOG.get(part.type);
          if (def === undefined) continue;
          const r = partBounds(def, part);
          if (r.x < box.x2 && r.x + r.w > box.x && r.y < box.y2 && r.y + r.h > box.y) hit.push(part.id);
        }
      }
      store.select(g.additive ? [...store.selection.value, ...hit] : hit);
    }
  };

  const onPointerLeave = (): void => {
    if (hoverPin.value !== null) {
      hoverPin.value = null;
      showTooltip(null);
    }
    if (hoverWire.value !== null) hoverWire.value = null;
  };

  const onDragOver = (event: DragEvent): void => {
    const types = event.dataTransfer?.types;
    if (types === undefined || (!types.includes(PART_MIME) && !types.includes('Files'))) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'copy';
  };

  const onDrop = (event: DragEvent): void => {
    const file = event.dataTransfer?.files[0];
    if (file !== undefined) {
      // A firmware file dropped onto a board.
      event.preventDefault();
      const board = document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((el) => el.closest<HTMLElement>('[data-part-id]'))
        .find((el) => el !== null && CATALOG.get(latest.current.doc.parts.find((p) => p.id === el.dataset.partId)?.type ?? '')?.board !== undefined);
      if (board?.dataset.partId === undefined) editorMessage.value = `Drop ${file.name} onto a board to load it.`;
      else void attachFirmwareFile(board.dataset.partId, file);
      return;
    }
    const type = event.dataTransfer?.getData(PART_MIME);
    const def = type ? CATALOG.get(type) : undefined;
    if (type === undefined || def === undefined) return;
    event.preventDefault();
    const at = toWorld(local(event));
    store.addPart(type, { x: at.x - def.size.w / 2, y: at.y - def.size.h / 2 }, !event.altKey);
  };

  return (
    <main
      class={`workbench${drawing.value !== null ? ' wiring' : ''}${simRunning.value ? ' running' : ''}${probeMode.value ? ' probing' : ''}`}
      ref={viewport}
      aria-label="Circuit canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div class="world" ref={world}>
        <EnvironmentLayer doc={doc} selection={selection} />
        {doc.parts.map((part) => (
          <PartView key={part.id} part={part} selected={selection.has(part.id)} />
        ))}
        <WireLayer doc={doc} netlist={netlist} spots={spots} selectedWire={selectedWire} />
      </div>
      <div class="marquee" ref={marquee} hidden />
      <div class="pin-tooltip" ref={tooltip} hidden />
      {doc.parts.length === 0 && (
        <div class="workbench-empty">
          <div class="workbench-empty-title">Empty bench</div>
          <div class="workbench-empty-body">Drag an Arduino Uno and a breadboard here from the parts list.</div>
        </div>
      )}
      {/* The signal itself, not .value: only this text node updates on zoom. */}
      <div class="zoom-badge">{zoomPercent}%</div>
    </main>
  );
}

function PartView({ part, selected }: { part: PartInstance; selected: boolean }) {
  const def = CATALOG.get(part.type);
  const wrapper = useRef<HTMLDivElement>(null);
  const element = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (def === undefined) return;
    let alive = true;
    const view = viewFor(part.type);
    let unbind = (): void => {};
    view
      .create(def, { ...def.defaults, ...part.props })
      .then((el) => {
        if (!alive) return;
        el.classList.add('part-element');
        if (isInteractive(part.type)) el.classList.add('interactive');
        element.current = el;
        wrapper.current?.append(el);
        // Frames from the worker update this view directly, never through Preact.
        const unregister = liveViews.register(part.id, (visual) => view.update(el, visual));
        // An IR remote's keys go to the receivers (views/ir-remote.ts); other parts' to themselves.
        const send = (input: PartInput): void => {
          for (const target of inputTargets(editor.doc.peek(), part.id)) sim.input(target, input);
        };
        const unbindInput = view.bindInput?.(el, send) ?? (() => {});
        unbind = () => {
          unregister();
          unbindInput();
        };
      })
      .catch((error: unknown) => console.warn(`benchtop: could not draw ${part.type}`, error));
    return () => {
      alive = false;
      unbind();
      element.current?.remove();
      element.current = null;
    };
  }, [part.type, part.id]);

  useEffect(() => {
    if (def !== undefined && element.current !== null) viewFor(part.type).setProps(element.current, { ...def.defaults, ...part.props });
  }, [part.props]);

  const size = def?.size ?? { w: 10, h: 10 };
  return (
    <div
      ref={wrapper}
      class={`part${selected ? ' selected' : ''}${def === undefined ? ' unknown' : ''}`}
      data-part-id={part.id}
      title={def === undefined ? `Unknown part type "${part.type}"` : undefined}
      style={{
        left: `${part.x * PX_PER_MM}px`,
        top: `${part.y * PX_PER_MM}px`,
        width: `${size.w * PX_PER_MM}px`,
        height: `${size.h * PX_PER_MM}px`,
        transform: part.rotation === 0 ? '' : `rotate(${part.rotation}deg)`,
      }}
    />
  );
}
