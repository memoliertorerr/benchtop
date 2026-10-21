/**
 * Pins in world mm: where every pin of every placed part is, and which one is under a point.
 */

import type { PartDefinition, PinRef, PinRole, ProjectDoc } from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';
import type { Point } from './camera.ts';
import { pinWorld } from './geometry.ts';

export interface PinSpot extends PinRef {
  x: number;
  y: number;
  role: PinRole;
}

/** Every pin of every part of a known type, in document then definition order. */
export function pinSpots(doc: ProjectDoc, definitions: ReadonlyMap<string, PartDefinition> = CATALOG): PinSpot[] {
  const spots: PinSpot[] = [];
  for (const part of doc.parts) {
    const def = definitions.get(part.type);
    if (def === undefined) continue;
    for (const pin of def.pins) {
      const at = pinWorld(def, part, pin);
      spots.push({ part: part.id, pin: pin.name, x: at.x, y: at.y, role: pin.role });
    }
  }
  return spots;
}

/** The world position of one pin, or undefined if the part or pin doesn't exist. */
export function pinPosition(
  doc: ProjectDoc,
  ref: PinRef,
  definitions: ReadonlyMap<string, PartDefinition> = CATALOG,
): Point | undefined {
  const part = doc.parts.find((p) => p.id === ref.part);
  const def = part && definitions.get(part.type);
  const pin = def?.pins.find((p) => p.name === ref.pin);
  return part && def && pin ? pinWorld(def, part, pin) : undefined;
}

/** The pin nearest to `point` within `radius` mm (later parts win ties: they're drawn on top). */
export function hitPin(spots: readonly PinSpot[], point: Point, radius: number): PinSpot | undefined {
  let best: PinSpot | undefined;
  let bestD = radius * radius;
  for (const spot of spots) {
    const dx = spot.x - point.x;
    const dy = spot.y - point.y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = spot;
    }
  }
  return best;
}
