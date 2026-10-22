/**
 * What a bench depends on in a document, as one string (BT77): equal signatures, the same bench.
 * The app compares them to tell an edit that changes the circuit from a cosmetic one — a wire's
 * color or waypoints, moving a part whose pins touch nothing new — which leaves a running bench
 * alone.
 *
 * Covered: each part's id, type and props; the nets, as which pins share one (a pin's net is
 * named by its smallest `part:pin`, so part order and net numbering don't matter; contacts are
 * in the netlist when its source had geometry); the firmware refs (an inline sketch by its FQBN
 * only: its code reaches the bench through a compile, not the document); and — only when the
 * document has an environment (an ambient part) — the position and rotation of every part the
 * environment simulates or samples.
 */

import type { PartProps } from '../contracts/part.ts';
import type { FirmwareRef, ProjectDoc } from '../contracts/project.ts';
import type { EnvSpecFor } from '../env/spec.ts';
import type { Netlist } from '../netlist/netlist.ts';

export interface SignatureOptions {
  /** The bench's environment specs: parts with one are placed by position. */
  envSpecFor?: EnvSpecFor;
  /** A type's default props, merged under the instance's before `envSpecFor` sees them. */
  defaults?: (type: string) => PartProps | undefined;
}

/** `netlist` must be the document's, built with the bench's pin source (geometry included). */
export function benchSignature(doc: ProjectDoc, netlist: Netlist, options: SignatureOptions = {}): string {
  const out: string[] = [];
  const parts = [...doc.parts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const part of parts) out.push(`p ${part.id} ${part.type} ${propsKey(part.props)}`);

  // Nets: every pin on a net of two or more, with its net's smallest pin name.
  const names: string[] = [];
  for (let net = 0; net < netlist.netCount; net++) {
    const pins = netlist.pinsOfNet(net);
    if (pins.length < 2) continue;
    let rep = '';
    names.length = 0;
    for (const pin of pins) {
      const name = `${pin.part}:${pin.pin}`;
      names.push(name);
      if (rep === '' || name < rep) rep = name;
    }
    for (const name of names) out.push(`n ${name} ${rep}`);
  }

  const boards = Object.keys(doc.firmware).sort();
  for (const board of boards) {
    out.push(`f ${board} ${firmwareKey(doc.firmware[board])}`);
  }

  const envSpecFor = options.envSpecFor;
  if (envSpecFor !== undefined) {
    const placed: string[] = [];
    let ambient = false;
    for (const part of parts) {
      const spec = envSpecFor(part.type, { ...options.defaults?.(part.type), ...part.props });
      if (spec === undefined) continue;
      if (spec.role === 'ambient') ambient = true;
      placed.push(`e ${part.id} ${part.x} ${part.y} ${part.rotation}`);
    }
    if (ambient) out.push(...placed);
  }
  out.sort(); // nets came in net-id order, which depends on part order
  return out.join('\n');
}

function sortedJson(value: object): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

/** A part's props as compared across rebuilds (BT78 keeps a model only when they are equal). */
export function propsKey(props: PartProps): string {
  return sortedJson(props);
}

/** A board's firmware ref as compared across rebuilds: an inline sketch by its FQBN (BT77/BT78). */
export function firmwareKey(ref: FirmwareRef | undefined): string {
  if (ref === undefined) return '';
  return ref.kind === 'inline' ? `inline ${ref.fqbn}` : sortedJson(ref);
}
