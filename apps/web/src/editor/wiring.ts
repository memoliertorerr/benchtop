/**
 * Wire-tool state shared by the canvas (input) and the wire layer (drawing): the wire being
 * drawn, the hovered pin or wire, rings where a dragged part's legs would land in holes, and a
 * waypoint being dragged. Plus the editor's view of nets (the same netlist rule the bench uses,
 * contacts included) and default wire colors.
 */

import { buildNetlist, type Netlist, type PartPinsSource, type PinRef, type ProjectDoc } from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';
import { signal } from '@preact/signals';
import type { Point } from './camera.ts';
import type { PinSpot } from './pins.ts';

export interface Drawing {
  from: PinSpot;
  waypoints: Point[];
  /** Where the preview ends: the cursor, snapped to the grid unless Alt is held. */
  cursor: Point;
}

export const drawing = signal<Drawing | null>(null);
export const hoverPin = signal<PinSpot | null>(null);
export const hoverWire = signal<string | null>(null);
/** Pin positions where a part being dragged would make contact (legs over holes). */
export const dropRings = signal<readonly Point[]>([]);
/** A selected wire's waypoints while one of them is dragged. */
export const waypointDrag = signal<{ wire: string; waypoints: Point[] } | null>(null);

/** Pins within this many mm of the pointer can be grabbed. Holes are 2.54 mm apart. */
export const PIN_HIT_MM = 0.9;

/** The ten wire colors offered; the document stores the name. */
export const WIRE_COLORS = ['black', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'white', 'gray', 'brown'] as const;

/** How each named color is drawn (softer than the CSS keywords). */
export const WIRE_SHADES: Readonly<Record<string, string>> = {
  black: '#26282c',
  red: '#d83c3c',
  green: '#2ea55a',
  blue: '#2f6fd8',
  yellow: '#e5c12a',
  orange: '#e9842c',
  purple: '#8e52c9',
  white: '#ecebe6',
  gray: '#8a9099',
  brown: '#8a5a32',
};

/** The catalog as a netlist source, geometry included, so contacts count. */
export const CATALOG_PINS: PartPinsSource = {
  pins: (type) => CATALOG.get(type)?.pins.map((p) => p.name),
  buses: (type) => CATALOG.get(type)?.buses ?? [],
  geometry: (type) => {
    const def = CATALOG.get(type);
    return def === undefined ? undefined : { size: def.size, pins: def.pins };
  },
};

const netlists = new WeakMap<ProjectDoc, Netlist>();

/** The document's nets (built once per document object: the canvas and the run controls share it). */
export function editorNetlist(doc: ProjectDoc): Netlist {
  let netlist = netlists.get(doc);
  if (netlist === undefined) {
    netlist = buildNetlist(doc, CATALOG_PINS);
    netlists.set(doc, netlist);
  }
  return netlist;
}

/**
 * Default color for a new wire between `a` and `b`: black if either end's net has a ground pin,
 * red if it has a supply pin, green otherwise.
 */
export function defaultWireColor(doc: ProjectDoc, netlist: Netlist, a: PinRef, b: PinRef): string {
  let supply = false;
  for (const end of [a, b]) {
    const net = netlist.netOf(end.part, end.pin);
    for (const ref of net < 0 ? [end] : netlist.pinsOfNet(net)) {
      const part = doc.parts.find((p) => p.id === ref.part);
      const pin = part && CATALOG.get(part.type)?.pins.find((p) => p.name === ref.pin);
      if (pin === undefined) continue;
      if (pin.role === 'ground' || pin.volts === 0) return 'black';
      if (pin.role === 'power' || (pin.volts ?? 0) > 0) supply = true;
    }
  }
  return supply ? 'red' : 'green';
}
