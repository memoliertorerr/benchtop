/**
 * The netlist: which pins are electrically one node. Topology only — signal values are the
 * resolver's job (packages/core/src/signals/).
 *
 * Every (part, pin) gets a dense index (parts in document order, pins in definition order).
 * Union-find over an Int32Array merges each part's internal buses, both ends of every wire and,
 * when the source gives geometry, every pair of touching pins (contacts.ts);
 * roots are then compacted to net ids 0..netCount-1, numbered in order of their lowest pin
 * index, so the same document always yields the same ids. Links (resistors, switches) are NOT
 * unions: they join nets only through the resolver. Merging a resistor's pins here would short
 * every pull-up.
 *
 * No incremental updates: the bench and the editor rebuild on every topology edit. 2,000 parts
 * and 4,000 wires build in a few milliseconds (see netlist.test.ts).
 */

import type { PinRef, ProjectDoc } from '../contracts/project.ts';
import { type Contact, findContacts, type PartGeometry } from './contacts.ts';

/**
 * Pin names and internal buses per part type. The caller supplies it (BT9 adapts the parts
 * catalog); core never imports @benchtop/parts.
 */
export interface PartPinsSource {
  /** Pin names of `type` in definition order, or undefined for an unknown type. */
  pins(type: string): readonly string[] | undefined;
  /** Pin-name groups shorted inside `type`; empty when it has none. */
  buses(type: string): readonly (readonly string[])[];
  /**
   * Optional: pin positions and size of `type`. When given, pins of different parts that touch
   * (within CONTACT_MM — a leg in a breadboard hole) are connected like a wire.
   */
  geometry?(type: string): PartGeometry | undefined;
}

/** An immutable view of one document's nets. */
export interface Netlist {
  /** Nets are numbered 0..netCount-1. Every known pin is on exactly one net. */
  readonly netCount: number;
  /** Net id of a pin; -1 when the part or pin is unknown. */
  netOf(part: string, pin: string): number;
  /** Every pin on `net`, in index order. The array is cached; don't mutate it. */
  pinsOfNet(net: number): readonly PinRef[];
  /** Wire ends that name a part or pin the source doesn't know; they join nothing. */
  readonly unresolved: readonly { wire: string; end: 'from' | 'to'; ref: PinRef }[];
  /** Ids of parts whose type the source doesn't know; they have no pins. */
  readonly unknownParts: readonly string[];
  /** Pins joined by touching (empty when the source has no geometry). */
  readonly contacts: readonly Contact[];
}

interface TypePins {
  readonly names: readonly string[];
  readonly offsets: ReadonlyMap<string, number>;
}

interface PartSlot {
  readonly base: number;
  readonly type: TypePins;
}

const NO_PINS: readonly PinRef[] = Object.freeze([]);

/** Builds the netlist of `doc`, with pins and buses from `source`. */
export function buildNetlist(doc: ProjectDoc, source: PartPinsSource): Netlist {
  // 1. Dense pin indexes: one base per part, one offset map per type (built once per type).
  const types = new Map<string, TypePins | null>();
  const slots = new Map<string, PartSlot>();
  const slotList: PartSlot[] = [];
  const partIds: string[] = [];
  const unknownParts: string[] = [];
  let pinCount = 0;
  for (const part of doc.parts) {
    let type = types.get(part.type);
    if (type === undefined) {
      const names = source.pins(part.type);
      if (names === undefined) type = null;
      else {
        const offsets = new Map<string, number>();
        for (let i = 0; i < names.length; i++) if (!offsets.has(names[i])) offsets.set(names[i], i);
        type = { names, offsets };
      }
      types.set(part.type, type);
    }
    if (type === null) {
      unknownParts.push(part.id);
      continue;
    }
    const slot: PartSlot = { base: pinCount, type };
    slots.set(part.id, slot);
    slotList.push(slot);
    partIds.push(part.id);
    pinCount += type.names.length;
  }

  // Which part (ordinal in slotList) each pin index belongs to, for pinsOfNet.
  const pinPart = new Int32Array(pinCount);
  for (let p = 0; p < slotList.length; p++) {
    const slot = slotList[p];
    pinPart.fill(p, slot.base, slot.base + slot.type.names.length);
  }

  // 2. Union-find with path halving and union by size.
  const parent = new Int32Array(pinCount);
  const size = new Int32Array(pinCount).fill(1);
  for (let i = 0; i < pinCount; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    if (size[ra] < size[rb]) {
      const t = ra;
      ra = rb;
      rb = t;
    }
    parent[rb] = ra;
    size[ra] += size[rb];
  };

  // 3. Buses inside each part. Names not in the pin list are a definition bug; they're skipped.
  const busCache = new Map<string, readonly (readonly string[])[]>();
  for (const part of doc.parts) {
    const slot = slots.get(part.id);
    if (slot === undefined) continue;
    let buses = busCache.get(part.type);
    if (buses === undefined) {
      buses = source.buses(part.type);
      busCache.set(part.type, buses);
    }
    for (const bus of buses) {
      let first = -1;
      for (const name of bus) {
        const offset = slot.type.offsets.get(name);
        if (offset === undefined) continue;
        if (first < 0) first = slot.base + offset;
        else union(first, slot.base + offset);
      }
    }
  }

  // 4. Wires.
  const indexOf = (ref: PinRef): number => {
    const slot = slots.get(ref.part);
    const offset = slot?.type.offsets.get(ref.pin);
    return slot === undefined || offset === undefined ? -1 : slot.base + offset;
  };
  const unresolved: { wire: string; end: 'from' | 'to'; ref: PinRef }[] = [];
  for (const wire of doc.wires) {
    const a = indexOf(wire.from);
    const b = indexOf(wire.to);
    if (a < 0) unresolved.push({ wire: wire.id, end: 'from', ref: { part: wire.from.part, pin: wire.from.pin } });
    if (b < 0) unresolved.push({ wire: wire.id, end: 'to', ref: { part: wire.to.part, pin: wire.to.pin } });
    if (a >= 0 && b >= 0) union(a, b);
  }

  // 4b. Contacts: touching pins of different parts join like a wire.
  const contacts = source.geometry === undefined ? [] : findContacts(doc, (type) => source.geometry?.(type));
  for (const contact of contacts) {
    const a = indexOf(contact.a);
    const b = indexOf(contact.b);
    if (a >= 0 && b >= 0) union(a, b);
  }

  // 5. Compact roots to net ids in order of their lowest pin index; reuse `size` as root → net.
  const pinNet = new Int32Array(pinCount);
  size.fill(-1);
  let netCount = 0;
  for (let i = 0; i < pinCount; i++) {
    const root = find(i);
    if (size[root] < 0) size[root] = netCount++;
    pinNet[i] = size[root];
  }

  // 6. net → pins in CSR form: netStart[n]..netStart[n+1] indexes into netPins.
  const netStart = new Int32Array(netCount + 1);
  for (let i = 0; i < pinCount; i++) netStart[pinNet[i] + 1]++;
  for (let n = 0; n < netCount; n++) netStart[n + 1] += netStart[n];
  const netPins = new Int32Array(pinCount);
  const fill = netStart.slice(0, netCount);
  for (let i = 0; i < pinCount; i++) netPins[fill[pinNet[i]]++] = i;

  const pinsCache: (readonly PinRef[] | undefined)[] = [];

  return {
    netCount,
    unresolved,
    unknownParts,
    contacts,
    netOf(part: string, pin: string): number {
      const slot = slots.get(part);
      const offset = slot?.type.offsets.get(pin);
      return slot === undefined || offset === undefined ? -1 : pinNet[slot.base + offset];
    },
    pinsOfNet(net: number): readonly PinRef[] {
      if (!Number.isInteger(net) || net < 0 || net >= netCount) return NO_PINS;
      let pins = pinsCache[net];
      if (pins === undefined) {
        const list: PinRef[] = [];
        for (let k = netStart[net]; k < netStart[net + 1]; k++) {
          const index = netPins[k];
          const p = pinPart[index];
          const slot = slotList[p];
          list.push({ part: partIds[p], pin: slot.type.names[index - slot.base] });
        }
        pins = Object.freeze(list);
        pinsCache[net] = pins;
      }
      return pins;
    },
  };
}
