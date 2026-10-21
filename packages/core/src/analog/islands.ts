/**
 * Analog islands: connected components over resistive links, switch links and diodes, rebuilt
 * only when the bench is (on topology change). Supply-driven nets are fixed voltages: they end an
 * island instead of joining two (so every LED to GND doesn't fuse into one island). A switch stays
 * in its component whether open or closed, so toggling it never changes the structure. Only
 * components with at least one resistive link or diode are kept; everything else is digital-only.
 */

export interface IslandElement {
  /** Net ids of the two ends. */
  a: number;
  b: number;
}

export interface Island {
  /** Unknown (non-fixed) nets, in local order. */
  nets: Int32Array;
  /** Resolver link indices of the island's resistive links. */
  resistors: Int32Array;
  /** Resolver link indices of its switch links. */
  switches: Int32Array;
  /** Indices into the diode list. */
  diodes: Int32Array;
}

export interface IslandInput {
  netCount: number;
  links: readonly (IslandElement & { kind: 'resistive' | 'switch' })[];
  diodes: readonly IslandElement[];
  /** Whether a net is fixed by a supply. */
  fixed: (net: number) => boolean;
}

export interface Islands {
  islands: Island[];
  /** Island index per net, or −1 (digital-only or fixed). */
  netIsland: Int32Array;
}

export function buildIslands(input: IslandInput): Islands {
  const { netCount, links, diodes, fixed } = input;
  const parent = new Int32Array(netCount);
  for (let i = 0; i < netCount; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    if (fixed(a) || fixed(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const link of links) union(link.a, link.b);
  for (const diode of diodes) union(diode.a, diode.b);

  // Group elements by the root of their non-fixed end (an element between two fixed nets, like
  // a resistor from 5V to GND, constrains nothing unknown and is skipped).
  const groups = new Map<number, { resistors: number[]; switches: number[]; diodes: number[]; analog: boolean }>();
  const groupOf = (a: number, b: number) => {
    const end = !fixed(a) ? a : !fixed(b) ? b : -1;
    if (end < 0) return undefined;
    const root = find(end);
    let group = groups.get(root);
    if (group === undefined) groups.set(root, (group = { resistors: [], switches: [], diodes: [], analog: false }));
    return group;
  };
  links.forEach((link, i) => {
    if (link.a === link.b) return;
    const group = groupOf(link.a, link.b);
    if (group === undefined) return;
    if (link.kind === 'resistive') {
      group.resistors.push(i);
      group.analog = true;
    } else {
      group.switches.push(i);
    }
  });
  diodes.forEach((diode, i) => {
    if (diode.a === diode.b) return;
    const group = groupOf(diode.a, diode.b);
    if (group === undefined) return;
    group.diodes.push(i);
    group.analog = true;
  });

  const netIsland = new Int32Array(netCount).fill(-1);
  const islands: Island[] = [];
  const members = new Map<number, number[]>();
  for (let net = 0; net < netCount; net++) {
    if (fixed(net)) continue;
    const root = find(net);
    if (groups.get(root)?.analog !== true) continue;
    let list = members.get(root);
    if (list === undefined) members.set(root, (list = []));
    list.push(net);
  }
  for (const [root, group] of groups) {
    if (!group.analog) continue;
    const nets = members.get(root) ?? [];
    const index = islands.length;
    for (const net of nets) netIsland[net] = index;
    islands.push({
      nets: Int32Array.from(nets),
      resistors: Int32Array.from(group.resistors),
      switches: Int32Array.from(group.switches),
      diodes: Int32Array.from(group.diodes),
    });
  }
  return { islands, netIsland };
}
