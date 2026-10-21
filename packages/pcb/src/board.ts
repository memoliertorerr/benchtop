/**
 * A PCB with its circuit (BT57): the PCB document plus the bench project it was laid out for,
 * and everything derived from the two — placed pads, nets, copper. Nets come from the bench's
 * own netlist (core's `buildNetlist`, contacts included), so breadboard strips and jumper wires
 * collapse into the nets they make; parts that aren't on a PCB (breadboards, the IR remote, the
 * environment) drop out.
 *
 * Net names: a board pin names its net — GND, 5V, 3V3, VIN as they are, numbered pins as D13,
 * analog ones as A0 (with several boards, the first board's pin) — else KiCad's
 * `Net-(<ref>-Pad<n>)` after the net's first pad.
 */

import { buildNetlist, type Netlist, type PartDefinition, type ProjectDoc } from '@benchtop/core';
import type { PcbDoc, PcbFootprint } from './doc.ts';
import { type Footprint, footprintOf, type PadShape } from './footprints.ts';
import { type Box, rotate } from './geometry.ts';

export interface PlacedPad {
  /** Index into PcbBoard.placed. */
  footprint: number;
  ref: string;
  part: string;
  pin: string;
  number: string;
  /** Centre on the board, mm. */
  x: number;
  y: number;
  shape: PadShape;
  /** Size on the board (turned with the footprint), mm. */
  w: number;
  h: number;
  drill: number;
  /** PCB net id, or −1 for a pad on no net (a pin nothing is wired to). */
  net: number;
}

export interface PcbNet {
  id: number;
  name: string;
  /** Indexes into PcbBoard.pads. */
  pads: number[];
}

export interface PlacedFootprint {
  doc: PcbFootprint;
  def: PartDefinition;
  footprint: Footprint;
  /** Courtyard on the board. */
  courtyard: Box;
}

/** Parts of the project and their definitions, through an injected catalog lookup. */
export type CatalogLookup = (type: string) => PartDefinition | undefined;

export class PcbBoard {
  readonly project: ProjectDoc;
  readonly pcb: PcbDoc;
  readonly placed: PlacedFootprint[] = [];
  readonly pads: PlacedPad[] = [];
  readonly nets: PcbNet[] = [];
  /** Footprint entries naming a part the project no longer has, or one that isn't on a PCB. */
  readonly stale: PcbFootprint[] = [];

  constructor(project: ProjectDoc, pcb: PcbDoc, catalog: CatalogLookup) {
    this.project = project;
    this.pcb = pcb;
    const partById = new Map(project.parts.map((p) => [p.id, p]));
    const netlist = projectNetlist(project, catalog);
    const pcbNetOf = new Map<number, number>();
    for (const doc of pcb.footprints) {
      const part = partById.get(doc.part);
      const def = part === undefined ? undefined : catalog(part.type);
      const footprint = def === undefined ? null : footprintOf(def);
      if (def === undefined || footprint === null) {
        this.stale.push(doc);
        continue;
      }
      const index = this.placed.length;
      const c = footprint.courtyard;
      const a = rotate(c.x0, c.y0, doc.rotation);
      const b = rotate(c.x1, c.y1, doc.rotation);
      this.placed.push({
        doc,
        def,
        footprint,
        courtyard: { x0: doc.x + Math.min(a.x, b.x), y0: doc.y + Math.min(a.y, b.y), x1: doc.x + Math.max(a.x, b.x), y1: doc.y + Math.max(a.y, b.y) },
      });
      for (const pad of footprint.pads) {
        const at = rotate(pad.x, pad.y, doc.rotation);
        const quarter = doc.rotation === 90 || doc.rotation === 270;
        const benchNet = netlist.netOf(doc.part, pad.pin);
        let net = -1;
        if (benchNet >= 0) {
          net = pcbNetOf.get(benchNet) ?? -1;
          if (net < 0) {
            net = this.nets.length;
            pcbNetOf.set(benchNet, net);
            this.nets.push({ id: net, name: '', pads: [] });
          }
          this.nets[net].pads.push(this.pads.length);
        }
        this.pads.push({
          footprint: index,
          ref: doc.ref,
          part: doc.part,
          pin: pad.pin,
          number: pad.number,
          x: doc.x + at.x,
          y: doc.y + at.y,
          shape: pad.shape,
          w: quarter ? pad.h : pad.w,
          h: quarter ? pad.w : pad.h,
          drill: pad.drill,
          net,
        });
      }
    }
    this.nameNets();
  }

  /** Nets that connect two or more distinct pads (the ones a layout must route). */
  get routable(): PcbNet[] {
    return this.nets.filter((n) => new Set(n.pads.map((i) => `${this.pads[i].footprint}:${this.pads[i].number}`)).size > 1);
  }

  private nameNets(): void {
    const used = new Set<string>();
    for (const net of this.nets) {
      let name: string | undefined;
      // A board pin names the net; supplies win over signals.
      const boardPins = net.pads.map((i) => this.pads[i]).filter((p) => this.placed[p.footprint].def.board !== undefined);
      const supply = boardPins.find((p) => {
        const pin = this.placed[p.footprint].def.pins.find((d) => d.name === p.pin);
        return pin?.role === 'power' || pin?.role === 'ground';
      });
      const named = supply ?? boardPins[0];
      if (named !== undefined) name = boardPinName(named.pin);
      if (name === undefined) {
        const first = net.pads.map((i) => this.pads[i]).sort((a, b) => compareRefs(a.ref, b.ref) || Number(a.number) - Number(b.number))[0];
        name = `Net-(${first.ref}-Pad${first.number})`;
      }
      let unique = name;
      for (let k = 1; used.has(unique); k++) unique = `${name}_${k}`;
      used.add(unique);
      net.name = unique;
    }
  }
}

/** The bench's netlist for a project (pins, buses and contact geometry from the catalog). */
export function projectNetlist(project: ProjectDoc, catalog: CatalogLookup): Netlist {
  return buildNetlist(project, {
    pins: (type) => catalog(type)?.pins.map((p) => p.name),
    buses: (type) => catalog(type)?.buses ?? [],
    geometry: (type) => {
      const def = catalog(type);
      return def === undefined ? undefined : { size: def.size, pins: def.pins };
    },
  });
}

/** A board pin's net name: "GND.2" → "GND", "13" → "D13", "A0" stays. */
export function boardPinName(pin: string): string {
  const base = pin.replace(/\.\d+$/, '');
  return /^\d+$/.test(base) ? `D${base}` : base;
}

/** R2 before R10: by prefix, then number. */
export function compareRefs(a: string, b: string): number {
  const ma = /^([A-Z]+)(\d+)$/.exec(a);
  const mb = /^([A-Z]+)(\d+)$/.exec(b);
  if (ma === null || mb === null) return a < b ? -1 : a > b ? 1 : 0;
  return ma[1] < mb[1] ? -1 : ma[1] > mb[1] ? 1 : Number(ma[2]) - Number(mb[2]);
}
