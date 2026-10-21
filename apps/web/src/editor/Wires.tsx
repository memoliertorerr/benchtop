/**
 * The wire layer: an SVG under the world transform, drawn in mm. Wires are orthogonal routes
 * with rounded corners and a solder dot at each end; an invisible wide stroke takes the clicks.
 * Also draws the wire being drawn, the selected wire's waypoint handles, hover rings and net
 * highlight, green dots on legs that sit in holes, green rings where a dragged part's legs
 * would land, and a small colored flag on each probed pin.
 */

import type { Netlist, ProjectDoc, Wire } from '@benchtop/core';
import { probes } from '../ui/logic/probes.ts';
import { PX_PER_MM, type Point } from './camera.ts';
import { type PinSpot, pinPosition } from './pins.ts';
import { orthogonalPath, pathData } from './routing.ts';
import { drawing, dropRings, hoverPin, hoverWire, WIRE_SHADES, waypointDrag } from './wiring.ts';

const shade = (color: string): string => WIRE_SHADES[color] ?? color;

/** The drawn polyline of a wire, or undefined when an end doesn't resolve. */
export function wireRoute(doc: ProjectDoc, wire: Wire, waypoints: readonly Point[] = wire.waypoints): Point[] | undefined {
  const from = pinPosition(doc, wire.from);
  const to = pinPosition(doc, wire.to);
  if (from === undefined || to === undefined) return undefined;
  return orthogonalPath([from, ...waypoints, to]);
}

export function WireLayer({
  doc,
  netlist,
  spots,
  selectedWire,
}: {
  doc: ProjectDoc;
  netlist: Netlist;
  spots: readonly PinSpot[];
  selectedWire: string | null;
}) {
  // Net highlight: the hovered pin's net, or the hovered wire's.
  const hovered = hoverPin.value;
  const hotWire = hoverWire.value;
  let hotNet = -1;
  if (hovered !== null) hotNet = netlist.netOf(hovered.part, hovered.pin);
  else if (hotWire !== null) {
    const wire = doc.wires.find((w) => w.id === hotWire);
    if (wire !== undefined) hotNet = netlist.netOf(wire.from.part, wire.from.pin);
  }
  const spotOf = new Map(spots.map((s) => [`${s.part}\u0000${s.pin}`, s]));
  const hotPins = hotNet < 0 ? [] : netlist.pinsOfNet(hotNet).map((r) => spotOf.get(`${r.part}\u0000${r.pin}`)).filter((s) => s !== undefined);
  const dragging = waypointDrag.value;
  const draft = drawing.value;

  return (
    <svg class="wire-layer" width="1" height="1" aria-hidden="true">
      <g transform={`scale(${PX_PER_MM})`}>
        {netlist.contacts.map((c) => {
          const at = spotOf.get(`${c.b.part}\u0000${c.b.pin}`) ?? spotOf.get(`${c.a.part}\u0000${c.a.pin}`);
          return at && <circle key={`${c.a.part}:${c.a.pin}-${c.b.part}:${c.b.pin}`} class="contact-dot" cx={at.x} cy={at.y} r={0.42} />;
        })}
        {doc.wires.map((wire) => {
          const waypoints = dragging?.wire === wire.id ? dragging.waypoints : wire.waypoints;
          const route = wireRoute(doc, wire, waypoints);
          if (route === undefined) return null;
          const d = pathData(route);
          const hot = hotNet >= 0 && netlist.netOf(wire.from.part, wire.from.pin) === hotNet;
          const selected = wire.id === selectedWire;
          const start = route[0];
          const end = route[route.length - 1];
          return (
            <g key={wire.id} class={`wire${hot ? ' hot' : ''}${selected ? ' selected' : ''}`}>
              <path class="wire-outline" d={d} />
              <path class="wire-core" d={d} stroke={shade(wire.color)} />
              <circle class="wire-dot" cx={start.x} cy={start.y} r={0.55} fill={shade(wire.color)} />
              <circle class="wire-dot" cx={end.x} cy={end.y} r={0.55} fill={shade(wire.color)} />
              <path class="wire-hit" d={d} data-wire-id={wire.id} />
            </g>
          );
        })}
        {selectedWire !== null &&
          (dragging?.wire === selectedWire ? dragging.waypoints : (doc.wires.find((w) => w.id === selectedWire)?.waypoints ?? [])).map(
            (p, i) => <rect key={i} class="waypoint-handle" data-waypoint={i} x={p.x - 0.7} y={p.y - 0.7} width={1.4} height={1.4} rx={0.25} />,
          )}
        {draft !== null && (
          <g class="wire drafting">
            <path class="wire-core" d={pathData(orthogonalPath([draft.from, ...draft.waypoints, draft.cursor]))} />
            {draft.waypoints.map((p, i) => (
              <circle key={i} class="wire-dot" cx={p.x} cy={p.y} r={0.4} />
            ))}
          </g>
        )}
        {hotPins.map((s) => (
          <circle key={`${s.part}:${s.pin}`} class="net-ring" cx={s.x} cy={s.y} r={0.95} />
        ))}
        {probes.value.map((probe) => {
          const at = spotOf.get(`${probe.pin.part}\u0000${probe.pin.pin}`);
          return (
            at && (
              <g key={probe.key} class="probe-flag" style={{ color: probe.color }}>
                <circle cx={at.x} cy={at.y} r={0.75} />
                <path d={`M${at.x} ${at.y - 0.75}V${at.y - 3.2}l1.9 0.65l-1.9 0.65`} />
              </g>
            )
          );
        })}
        {hovered !== null && <circle class="pin-ring" cx={hovered.x} cy={hovered.y} r={1.05} />}
        {dropRings.value.map((p, i) => (
          <circle key={i} class="drop-ring" cx={p.x} cy={p.y} r={0.95} />
        ))}
      </g>
    </svg>
  );
}
