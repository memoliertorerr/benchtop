/**
 * Benchtop's headless runner (`npm run bench -- <command> …`; plain Node type stripping — no
 * build step, no loader):
 *   run <project.json> --firmware <board>=<file> [--firmware …] [--script steps.json]
 *       [--expect '<assertion>']… [--duration 3s] [--report out.json]
 *     Prints the JSON report on stdout (or to --report), a one-line summary on stderr, and
 *     exits 0 (all assertions passed), 1 (one failed) or 2 (usage, load or run error).
 *   test <spec.bench.json|folder>… [--jobs N] [--junit out.xml] [--markdown out.md] [--report out.json]
 *     Runs every *.bench.json spec found (BT48) on worker threads; prints a line per spec and a
 *     summary, writes the reports asked for, and exits like `run` (2 if a spec couldn't run).
 *   gdb [--port 3333] [--speed realtime|max] [--board <id>] <project.json> --firmware <board>=<file.elf>
 *     A GDB remote stub on 127.0.0.1 for one board; runs until interrupted (Ctrl-C).
 *   pcb <project.json> [--pcb layout.pcb.json] --out <folder> [--zip] [--drc]
 *     BT58: the project's PCB (the layout given, else one seeded from the bench) checked by DRC
 *     and exported — Gerbers, drill, BOM, KiCad netlist + footprints, the layout — into the
 *     folder (or one ZIP). Exits 0, 1 with --drc when DRC finds an error, 2 on a usage error.
 *   mcp [--root <folder>] [--max-sim <time>] [--max-wall <seconds>]
 *     BT68: a Model Context Protocol server on stdio (mcp/): an AI assistant reads the catalog,
 *     validates and runs circuits and test specs, with every path inside the root folder.
 * `--network host:port[,host:port…]` (BT101; run, test, mcp): a project's WiFi access point whose
 * `internet` is on may reach those hosts — the ones its own allow list names too. Without it,
 * nothing leaves the machine.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseGdbArgs, startGdbServer } from './gdb.ts';
import { nodeIo } from './node-io.ts';
import { parseAllowList } from '@benchtop/core';
import type { CliIo } from './load.ts';
import { parsePcbArgs, runPcb } from './pcb.ts';
import { runMcp } from './mcp/command.ts';
import { junitXml, markdownReport } from './reports.ts';
import { parseRunArgs, type RunReport, runHeadless, summaryLine, UsageError } from './run.ts';
import { discoverSpecs, parseTestArgs, runSuite, specLine, suiteLine } from './suite.ts';

const USAGE = `usage: benchtop run <project.json> --firmware <board>=<file.hex|.elf|.bin> [--firmware …]
         [--script <steps.json>] [--expect '<assertion>']… [--duration <time>] [--report <out.json>]
       benchtop test <spec.bench.json|folder>… [--jobs N] [--junit <out.xml>] [--markdown <out.md>]
         [--report <out.json>]
       benchtop gdb [--port 3333] [--speed realtime|max] [--board <id>] <project.json>
         --firmware <board>=<file.elf>
       benchtop pcb <project.json> [--pcb <layout.pcb.json>] --out <folder> [--zip] [--drc]
       benchtop mcp [--root <folder>] [--max-sim <time>] [--max-wall <seconds>]
  --network host:port[,…]  (run, test, mcp) the real hosts a project's WiFi access point may reach
  assertions: serial contains "<text>" by <time>   ·   serial matches /<regex>/ by <time>
    pin <part>:<pin> is <0|1|z|x> at <time>
    pin <part>:<pin> frequency is <hz> ±<pct>% between <time> and <time>
    pin <part>:<pin> duty is <pct>% ±<pct> between <time> and <time>
    led <part> is <lit|dark> at <time>   ·   servo <part> angle is <deg> ±<deg> at <time>
    lcd <part> row <n> is "<text>" at <time>   ·   pixel <part>[<i>] is #rrggbb at <time>
    digits <part> show "<text>" at <time>
    env <gas|temperature|humidity|light|sound> at <part> is <v> ±<tol> at <time> (or > < >= <=)
    wifi <board> connected by <time>   ·   http <server> served <METHOD> <path> by <time>
    http <client> got <status> [with "<text>"] by <time>
  steps: { "at", "part", "input" } · { "at", "part", "set": { <channel>: <value> } } · { "at", "serial", "board"? }
  times: <number><ns|us|ms|s>, e.g. 500ms, 2s`;

let io: typeof nodeIo & Pick<CliIo, 'network'> = nodeIo;

/**
 * BT101: takes `--network <list>` out of the arguments (any command but gdb and pcb) into `io`;
 * a usage error for a bad list.
 */
function takeNetwork(argv: readonly string[]): string[] | string {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--network') {
      rest.push(argv[i]);
      continue;
    }
    const value = argv[++i];
    if (value === undefined) return '--network needs host:port[,host:port…]';
    const { entries, errors } = parseAllowList(value);
    if (errors.length > 0) return `--network: ${errors.join('; ')}`;
    io = { ...io, network: [...(io.network ?? []), ...entries] };
  }
  return rest;
}

function usageReport(message: string): RunReport {
  return { ok: false, exitCode: 2, simulatedNs: 0, wallMs: 0, simulatedMHz: 0, assertions: [], serial: {}, problems: [], error: message };
}

async function gdb(argv: readonly string[]): Promise<number> {
  try {
    const server = await startGdbServer({ ...parseGdbArgs(argv), io });
    console.info(`listening on ${server.address}:${server.port} (board ${server.board})`);
    process.once('SIGINT', () => void server.close().then(() => process.exit(0)));
    return 0;
  } catch (error) {
    console.error(`error — ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
}

async function test(argv: readonly string[]): Promise<number> {
  let options: ReturnType<typeof parseTestArgs>;
  let files: string[];
  try {
    options = parseTestArgs(argv);
    files = discoverSpecs(options.paths, io);
    if (files.length === 0) throw new UsageError(`no *.bench.json specs in ${options.paths.join(', ')}`);
  } catch (error) {
    console.error(`error — ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const report = await runSuite(files, io, options.jobs);
  for (const spec of report.specs) console.info(specLine(spec));
  console.info(suiteLine(report));
  const write = (path: string | undefined, text: string): void => {
    if (path !== undefined) writeFileSync(resolve(process.cwd(), path), text);
  };
  write(options.junit, junitXml(report));
  write(options.markdown, markdownReport(report));
  write(options.report, `${JSON.stringify(report, null, 2)}\n`);
  return report.exitCode;
}

function pcb(argv: readonly string[]): number {
  let options: ReturnType<typeof parsePcbArgs>;
  try {
    options = parsePcbArgs(argv);
  } catch (error) {
    console.error(`error — ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const result = runPcb(options, io);
  for (const line of result.lines) (result.exitCode === 2 ? console.error : console.info)(line);
  for (const file of result.files) {
    const path = resolve(process.cwd(), options.out, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.data);
  }
  if (result.files.length > 0) console.info(`wrote ${result.files.length} file${result.files.length === 1 ? '' : 's'} to ${options.out}`);
  return result.exitCode;
}

function main(argv: readonly string[]): number | Promise<number> {
  const [command, ...args] = argv;
  if (command === 'gdb') return gdb(args);
  if (command === 'pcb') return pcb(args);
  const rest = takeNetwork(args);
  if (typeof rest === 'string') {
    console.error(`error — ${rest}\n${USAGE}`);
    return 2;
  }
  if (command === 'test') return test(rest);
  if (command === 'mcp') return runMcp(rest, io);
  if (command !== 'run') {
    console.error(command === undefined || command === '--help' || command === '-h' ? USAGE : `unknown command "${command}"\n${USAGE}`);
    return 2;
  }
  let options: ReturnType<typeof parseRunArgs>;
  try {
    options = parseRunArgs(rest);
  } catch (error) {
    const message = error instanceof UsageError ? error.message : String(error);
    process.stdout.write(`${JSON.stringify(usageReport(message), null, 2)}\n`);
    console.error(`error — ${message}\n${USAGE}`);
    return 2;
  }
  const report = runHeadless(options, io);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.report !== undefined) writeFileSync(resolve(process.cwd(), options.report), json);
  else process.stdout.write(json);
  console.error(summaryLine(report));
  return report.exitCode;
}

process.exitCode = await main(process.argv.slice(2));
