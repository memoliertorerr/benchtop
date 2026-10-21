/**
 * The examples gallery for MCP clients (BT69): `list_examples`, `open_example` (a live session
 * on an example's own circuit and firmware) and the resources `benchtop://examples/<id>` (an
 * example's card and project document). The list is fixtures/examples.json — the web gallery's
 * too — in the Benchtop repository, read by id only: these files are outside the root folder's
 * rule because nothing a client sends becomes a path here, only an id from the fixed list.
 */

import { join } from 'node:path';
import type { DebugTables, FirmwareImage, ProjectDoc } from '@benchtop/core';
import { parseJson, projectFromJson, readText } from '../../load.ts';
import type { CliIo } from '../../load.ts';
import type { SuiteIo } from '../../suite.ts';
import type { ResourceProvider } from '../server.ts';
import { type Tool, ToolError } from '../server.ts';
import { nmTables, openSession, type SimContext } from './sim.ts';

export type ExampleBoard = { firmware: string; sketch: string } | { micropython: string };

export interface ExampleEntry {
  id: string;
  title: string;
  category: string;
  project: string;
  boards: Record<string, ExampleBoard>;
  description: string;
  pcb?: string;
}

export const EXAMPLE_URI = 'benchtop://examples/';

/** The repository's examples and their files, read through the unconfined file access. */
export class ExampleLibrary {
  private readonly repo: string;
  private readonly io: CliIo & Pick<SuiteIo, 'list'>;
  private entries: ExampleEntry[] | null = null;

  constructor(repo: string, io: CliIo & Pick<SuiteIo, 'list'>) {
    this.repo = repo;
    this.io = io;
  }

  list(): ExampleEntry[] {
    this.entries ??= parseJson(readText(this.io, join(this.repo, 'fixtures/examples.json'), 'examples'), 'fixtures/examples.json') as ExampleEntry[];
    return this.entries;
  }

  get(id: string): ExampleEntry {
    const entry = this.list().find((e) => e.id === id);
    if (entry === undefined) throw new ToolError(`no example "${id}" — list_examples shows them`);
    return entry;
  }

  projectJson(entry: ExampleEntry): unknown {
    return parseJson(readText(this.io, join(this.repo, 'fixtures/projects', `${entry.project}.json`), 'project'), entry.project);
  }

  /** Each board's firmware: the committed build, or the MicroPython sketch's .py files. */
  images(entry: ExampleEntry): Record<string, FirmwareImage> {
    const images: Record<string, FirmwareImage> = {};
    for (const [board, files] of Object.entries(entry.boards)) {
      if ('micropython' in files) {
        const dir = join(this.repo, 'fixtures/micropython', files.micropython);
        const sources = Object.fromEntries(
          this.io
            .list(dir)
            .filter((f) => !f.directory && f.name.endsWith('.py'))
            .map((f) => [f.name, readText(this.io, join(dir, f.name), 'sketch')]),
        );
        images[board] = { format: 'micropython', files: sources, main: 'main.py' };
        continue;
      }
      const path = join(this.repo, 'fixtures/firmware', files.firmware);
      const bytes = this.io.readFile(path);
      if (path.endsWith('.hex')) images[board] = { format: 'hex', text: new TextDecoder().decode(bytes) };
      else if (path.endsWith('.uf2')) images[board] = { format: 'uf2', bytes };
      else images[board] = { format: 'esp32-bin', app: bytes, partitions: this.io.readFile(path.replace(/\.bin$/, '.partitions.bin')) };
    }
    return images;
  }

  /** BT74: symbols for boards whose committed firmware has a `.syms.tsv` beside it (every ESP32 fixture). */
  tables(entry: ExampleEntry, doc: ProjectDoc): Record<string, DebugTables> {
    const out: Record<string, DebugTables> = {};
    for (const [board, files] of Object.entries(entry.boards)) {
      if ('micropython' in files) continue;
      try {
        const text = readText(this.io, join(this.repo, 'fixtures/firmware', files.firmware.replace(/\.(hex|uf2|bin)$/, '.syms.tsv')), 'symbols');
        out[board] = nmTables(text, doc, board);
      } catch {
        // no listing: addresses only
      }
    }
    return out;
  }

  /** The sketch source of a board's firmware (its main file), for the assistant to read. */
  sketch(entry: ExampleEntry, board: string): { files: Record<string, string> } | undefined {
    const files = entry.boards[board];
    if (files === undefined) return undefined;
    const dir = 'micropython' in files ? join(this.repo, 'fixtures/micropython', files.micropython) : join(this.repo, 'fixtures/sketches', files.sketch);
    const sources: Record<string, string> = {};
    for (const f of this.io.list(dir)) if (!f.directory && /\.(ino|h|hpp|c|cpp|py|pio)$/.test(f.name)) sources[f.name] = readText(this.io, join(dir, f.name), 'sketch');
    return { files: sources };
  }
}

export interface ExamplesContext extends SimContext {
  examples: ExampleLibrary;
}

const card = (e: ExampleEntry) => ({
  id: e.id,
  title: e.title,
  category: e.category,
  description: e.description,
  boards: Object.fromEntries(Object.entries(e.boards).map(([board, b]) => [board, 'micropython' in b ? `MicroPython (${b.micropython})` : b.firmware])),
});

export const listExamples: Tool<ExamplesContext> = {
  name: 'list_examples',
  title: 'List the examples',
  description:
    'The examples gallery: ready-made circuits with their firmware (Arduino Uno/Nano/Mega, ESP32, Raspberry Pi Pico and Pico 2, MicroPython), by category. open_example runs one live; the resource benchtop://examples/<id> holds its project document and sketch — a good starting point for a project of your own.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', maxLength: 100, description: 'Text to look for in the id, title or description.' },
      category: { type: 'string', maxLength: 64, description: 'Only this category (e.g. "Basics", "ESP32", "Raspberry Pi Pico 2").' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
    const all = context.examples.list();
    const shown = all.filter((e) => (args.category === undefined || e.category === args.category) && (query === '' || `${e.id} ${e.title} ${e.description}`.toLowerCase().includes(query)));
    return { count: shown.length, categories: [...new Set(all.map((e) => e.category))], examples: shown.map(card) };
  },
};

export const openExample: Tool<ExamplesContext> = {
  name: 'open_example',
  title: 'Open an example live',
  description: 'Opens a live session (as sim_open does) on a gallery example\'s circuit and its own firmware; then sim_run, sim_input, sim_state. Returns the session id and, per board, the sketch source it runs.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', maxLength: 64, description: 'An example id from list_examples.' },
      watch: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 80 }, description: 'Pins to measure on every sim_run, as "part:pin".' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const entry = context.examples.get(args.id as string);
    const { doc, boards } = projectFromJson(context.examples.projectJson(entry));
    const opened = openSession(context, `example ${entry.id}`, doc, boards, context.examples.images(entry), (args.watch ?? []) as string[], context.examples.tables(entry, doc));
    const sketches = Object.fromEntries(boards.map((b) => [b, context.examples.sketch(entry, b)?.files ?? {}]));
    return { ...opened, example: card(entry), sketches };
  },
};

/** benchtop://examples/<id>: the card, the project document and the sketches. */
export function exampleResources(examples: ExampleLibrary): ResourceProvider {
  return {
    list: () => examples.list().map((e) => ({ uri: `${EXAMPLE_URI}${e.id}`, name: e.id, title: e.title, description: e.description, mimeType: 'application/json' })),
    templates: () => [{ uriTemplate: `${EXAMPLE_URI}{id}`, name: 'example', title: 'A gallery example', description: 'An example\'s card, project document and sketch sources (ids from list_examples).', mimeType: 'application/json' }],
    read(uri) {
      if (!uri.startsWith(EXAMPLE_URI)) return undefined;
      const entry = examples.list().find((e) => e.id === uri.slice(EXAMPLE_URI.length));
      if (entry === undefined) return undefined;
      const sketches = Object.fromEntries(Object.keys(entry.boards).map((b) => [b, examples.sketch(entry, b)?.files ?? {}]));
      return { mimeType: 'application/json', text: JSON.stringify({ ...card(entry), project: examples.projectJson(entry), sketches }, null, 1) };
    },
  };
}
