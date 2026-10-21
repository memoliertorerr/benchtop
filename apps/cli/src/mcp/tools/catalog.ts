/**
 * The part catalog as MCP tools (BT68): `list_parts` to find a part type, `describe_part` for
 * what a project needs to use it — pins (names, roles, supplies), props and their defaults, the
 * board's MCU and pin map, and the inputs it takes while running (`PART_INPUTS`).
 */

import { CATALOG, PART_CATEGORIES, partInputs } from '@benchtop/parts';
import { type Tool, ToolError } from '../server.ts';
import type { ToolContext } from './context.ts';

const CATEGORY_IDS = PART_CATEGORIES.map((c) => c.id);

export const listParts: Tool<ToolContext> = {
  name: 'list_parts',
  title: 'List parts',
  description:
    'Lists the part types a Benchtop project can place: boards (Arduino Uno, Nano, Mega, ESP32 DevKit, Raspberry Pi Pico and Pico 2), breadboards, LEDs, resistors, buttons, displays, sensors, motors and environment sources. Filter by text (matched against type and title) or category. Use describe_part for a type\'s pins and props.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', maxLength: 100, description: 'Text to look for in the type or title (case-insensitive).' },
      category: { type: 'string', enum: CATEGORY_IDS, description: 'Only this palette category.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args) {
    const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
    const parts = [...CATALOG.values()]
      .filter((def) => (args.category === undefined || def.category === args.category) && (query === '' || def.type.includes(query) || def.title.toLowerCase().includes(query)))
      .map((def) => ({
        type: def.type,
        title: def.title,
        category: def.category,
        pins: def.pins.length,
        ...(def.board === undefined ? {} : { mcu: def.board.mcu }),
        ...(partInputs(def.type).length > 0 ? { takesInput: true } : {}),
      }));
    return { count: parts.length, categories: CATEGORY_IDS, parts };
  },
};

export const describePart: Tool<ToolContext> = {
  name: 'describe_part',
  title: 'Describe a part',
  description:
    'Everything a project needs to use one part type: its pins (name, role — digital, analog, power, ground, passive, nc — and supply volts), pins shorted inside it (buses), its props with their defaults (put overrides in the part\'s "props"), size in mm, and for boards the MCU and the header-pin → MCU-pin map. "inputs" lists what the part takes while running (press/release, a value in a unit, named keys, or channels set as { "set": { "<channel>": <number> } } in steps).',
  inputSchema: {
    type: 'object',
    properties: { type: { type: 'string', maxLength: 64, description: 'A part type from list_parts, e.g. "arduino-uno", "led", "dht22".' } },
    required: ['type'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args) {
    const def = CATALOG.get(args.type as string);
    if (def === undefined) throw new ToolError(`no part type "${String(args.type)}" — list_parts shows them`);
    // Breadboards have hundreds of holes: their pin list is summarized.
    const many = def.pins.length > 120;
    return {
      type: def.type,
      title: def.title,
      category: def.category,
      sizeMm: def.size,
      pins: many
        ? { count: def.pins.length, examples: def.pins.slice(0, 12).map((p) => p.name), note: 'a breadboard: holes are "<column><row>" (e.g. "5t.a"); each 5-hole strip and each rail is one bus' }
        : def.pins.map((p) => ({ name: p.name, role: p.role, ...(p.volts === undefined ? {} : { volts: p.volts }) })),
      ...(def.buses === undefined || many ? {} : { buses: def.buses }),
      ...(def.links === undefined ? {} : { links: def.links.map((l) => ({ id: l.id, a: l.a, b: l.b, kind: l.kind, ...(l.ohms === undefined ? {} : { ohms: l.ohms }) })) }),
      props: def.defaults,
      ...(def.board === undefined ? {} : { board: { mcu: def.board.mcu, pinMap: def.board.pinMap } }),
      inputs: partInputs(def.type),
    };
  },
};
