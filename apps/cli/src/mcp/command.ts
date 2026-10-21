/**
 * `bench mcp [--root <folder>] [--max-sim <time>] [--max-wall <seconds>]` (BT68): Benchtop as a
 * Model Context Protocol server on stdio. stdout carries protocol messages only — while it
 * serves, `console.*` goes to stderr — and the server stops when stdin closes.
 */

import { createInterface } from 'node:readline';
import { UsageError } from '../load.ts';
import { formatNs, parseTime } from '../run.ts';
import type { SuiteIo } from '../suite.ts';
import { Sandbox } from './sandbox.ts';
import { DEFAULT_LIMITS, type McpLimits, McpServer, type ResourceProvider, serveLines, type Tool } from './server.ts';
import { describePart, listParts } from './tools/catalog.ts';
import { ExampleLibrary, type ExamplesContext, exampleResources, listExamples, openExample } from './tools/examples.ts';
import { runSimulation, runTests, validateProject } from './tools/run.ts';
import { SIM_TOOLS } from './tools/sim.ts';
import { BUILD_TOOLS } from './tools/build.ts';
import { DEBUG_TOOLS } from './tools/debug.ts';
import { Sessions } from './sessions.ts';
import { REPO } from '../node-io.ts';

export interface McpOptions {
  root: string;
  limits: McpLimits;
}

/** `mcp` arguments. */
export function parseMcpArgs(argv: readonly string[], cwd: string): McpOptions {
  let root = cwd;
  const limits = { ...DEFAULT_LIMITS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    if (arg === '--root') root = value();
    else if (arg === '--max-sim') {
      limits.maxSimNs = parseTime(value());
      if (limits.maxSimNs <= 0) throw new UsageError('--max-sim must be positive');
    } else if (arg === '--max-wall') {
      const seconds = Number(value());
      if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError('--max-wall must be a positive number of seconds');
      limits.maxWallMs = seconds * 1000;
    } else throw new UsageError(`unknown mcp option ${arg}`);
  }
  return { root, limits };
}

export const TOOLS: readonly Tool<ExamplesContext>[] = [listParts, describePart, validateProject, runSimulation, runTests, ...SIM_TOOLS, listExamples, openExample, ...DEBUG_TOOLS, ...BUILD_TOOLS];

function instructions(sandbox: Sandbox, limits: McpLimits): string {
  return [
    'Benchtop simulates Arduino Uno/Nano/Mega, ESP32 and Raspberry Pi Pico/Pico 2 circuits running real compiled firmware (or inline MicroPython on the Picos), headless.',
    'A project is a JSON document of placed parts and wires; list_parts and describe_part show the part types, their pins and props; validate_project checks one.',
    'run_simulation runs a project with firmware, timed inputs and assertions (pin levels, frequency and duty, serial text, LEDs, displays) and reports what happened; run_tests runs *.bench.json specs.',
    'For step-by-step work open a live session (sim_open, or open_example on a gallery example from list_examples) and drive it with sim_run, sim_input, sim_serial and sim_state; debug_* tools debug any board\'s firmware in a session (registers, memory, breakpoints, steps).',
    'compile_sketch builds an Arduino sketch with the local arduino-cli; pcb_check and pcb_export check a project\'s PCB and write its fabrication files. Files are written only under .benchtop/ in the root.',
    `Paths are relative to the root folder ${sandbox.root} and must stay inside it. A call may simulate at most ${formatNs(limits.maxSimNs)} and spend ${limits.maxWallMs / 1000} s of wall time.`,
  ].join(' ');
}

/** `repo`: the Benchtop repository whose fixtures hold the gallery's examples. */
export function createMcpServer(options: McpOptions, baseIo: SuiteIo, repo = REPO): McpServer<ExamplesContext> {
  const sandbox = new Sandbox(options.root);
  const examples = new ExampleLibrary(repo, baseIo);
  const context: ExamplesContext = { sandbox, io: sandbox.io(baseIo), limits: options.limits, sessions: new Sessions(options.limits.maxSessions), examples };
  const resources: ResourceProvider[] = [exampleResources(examples)];
  return new McpServer({ tools: TOOLS, resources, context, instructions: instructions(sandbox, options.limits) });
}

/** Serves on stdin/stdout until stdin ends. */
export async function runMcp(argv: readonly string[], baseIo: SuiteIo): Promise<number> {
  let server: McpServer<ExamplesContext>;
  try {
    server = createMcpServer(parseMcpArgs(argv, process.cwd()), baseIo);
  } catch (error) {
    console.error(`error — ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  // Nothing but protocol messages on stdout: anything else that logs goes to stderr.
  const toStderr = (...items: unknown[]): void => void process.stderr.write(`${items.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  await serveLines(server as McpServer<unknown>, lines, (line) => void process.stdout.write(line));
  return 0;
}
