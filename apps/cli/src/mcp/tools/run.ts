/**
 * Checking and running circuits as MCP tools (BT68): `validate_project` (the document's errors,
 * then the circuit check's problems on a bench built without firmware), `run_simulation` (the
 * CLI's `run`: firmware, scripted steps, assertions, the JSON report) and `run_tests` (the CLI's
 * `test` over *.bench.json specs, one after another within the call's budget).
 */

import { parseProject } from '@benchtop/core';
import { benchEnvParts } from '@benchtop/parts';
import { buildBench, cachedRoms } from '../../load.ts';
import { parseTime, type RunReport, runHeadless } from '../../run.ts';
import { defaultSpecName, loadSpec } from '../../spec.ts';
import { discoverSpecs } from '../../suite.ts';
import { type Tool, ToolError } from '../server.ts';
import { MICROPYTHON_ARG, PROJECT_ARGS, projectJsonArg, timeText, type ToolContext, trimSerial, withMicroPython } from './context.ts';

export const validateProject: Tool<ToolContext> = {
  name: 'validate_project',
  title: 'Validate a project',
  description:
    'Checks a Benchtop project document without running it: schema errors (each with its JSON path), then the circuit as wired — unknown part types, wires to pins that don\'t exist, unwired or unpowered parts, unconnected pins that matter, 5 V into an ESP32. What only shows while running (shorts, LED overcurrent, a 5 V signal into a 3.3 V input) is in run_simulation\'s problems. Returns the board part ids too.',
  inputSchema: { type: 'object', properties: PROJECT_ARGS, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
  run(args, context) {
    const { json, label } = projectJsonArg(args, context);
    const parsed = parseProject(json);
    if (!parsed.ok) return { ok: false, project: label, errors: parsed.errors.slice(0, 50).map((e) => ({ path: e.path || '/', message: e.message })), errorCount: parsed.errors.length };
    const doc = parsed.doc;
    const { bench } = buildBench(doc, {}, cachedRoms(context.io));
    try {
      const problems = bench.problems().filter((p) => !p.code.startsWith('mcu-'));
      const boards = doc.parts.filter((p) => benchEnvParts(p.type)?.board !== undefined).map((p) => p.id);
      return { ok: true, project: label, name: doc.name, parts: doc.parts.length, wires: doc.wires.length, boards, problems };
    } finally {
      bench.dispose();
    }
  },
};

export const runSimulation: Tool<ToolContext> = {
  name: 'run_simulation',
  title: 'Run a simulation',
  description: [
    'Runs a Benchtop circuit headless with real compiled firmware (Arduino Uno/Nano/Mega .hex or .elf, ESP32 .bin, Raspberry Pi Pico/Pico 2 .uf2) or inline MicroPython, applies timed steps, checks assertions and returns the report: each assertion with ok and detail, every board\'s serial output, the problems found (shorts, overcurrent, a faulted MCU), simulated time and speed.',
    'Times are strings: "500ms", "2s", "100us". The run lasts "duration", else until the last step or assertion.',
    'Steps: { "at": "1s", "part": "btn1", "input": { "kind": "press" } } (kinds press, release, value with "value", key with "key" and "down"), { "at": "1s", "part": "dht", "set": { "temperature": 30 } }, { "at": "1s", "serial": "hello\\n", "board": "uno" }.',
    'Assertions: serial contains "<text>" by <time> · serial matches /<regex>/ by <time> · pin <part>:<pin> is <0|1|z|x> at <time> · pin <part>:<pin> frequency is <hz> ±<pct>% between <time> and <time> · pin <part>:<pin> duty is <pct>% ±<pct> between <time> and <time> · led <part> is <lit|dark> at <time> · servo <part> angle is <deg> ±<deg> at <time> · lcd <part> row <n> is "<text>" at <time> · pixel <part>[<i>] is #rrggbb at <time> · digits <part> show "<text>" at <time> · env <gas|temperature|humidity|light|sound> at <part> is <v> ±<tol> at <time>.',
    'ok is false when an assertion failed; isError when the run could not start (a bad project, missing firmware, a limit).',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      ...PROJECT_ARGS,
      firmware: { type: 'object', additionalProperties: { type: 'string', maxLength: 1024 }, description: 'Board part id → firmware file under the root (.hex, .elf, an ESP32 .bin, .uf2, or a one-file MicroPython .py).' },
      micropython: MICROPYTHON_ARG,
      steps: { type: 'array', maxItems: 1000, items: { type: 'object' }, description: 'Timed inputs and serial sends (see the description).' },
      expect: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 2000 }, description: 'Assertions (see the description).' },
      duration: { type: 'string', maxLength: 32, description: 'How long to run, e.g. "3s".' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  run(args, context) {
    const { json, label } = projectJsonArg(args, context);
    if (typeof args.duration === 'string') parseTime(args.duration); // a usage error before anything loads
    const report = runHeadless(
      {
        project: label,
        projectJson: withMicroPython(json, args.micropython),
        firmware: (args.firmware ?? {}) as Record<string, string>,
        ...(args.steps === undefined ? {} : { scriptJson: { steps: args.steps } }),
        expect: (args.expect ?? []) as string[],
        duration: args.duration as string | undefined,
        maxDurationNs: context.limits.maxSimNs,
        maxWallMs: context.limits.maxWallMs,
      },
      context.io,
    );
    if (report.exitCode === 2) throw new ToolError(report.error ?? 'the run failed');
    const { serial, truncated } = trimSerial(report.serial, context.limits.serialChars);
    return {
      ok: report.ok,
      simulated: timeText(report.simulatedNs),
      simulatedNs: report.simulatedNs,
      wallMs: report.wallMs,
      simulatedMHz: report.simulatedMHz,
      assertions: report.assertions,
      serial,
      ...(truncated.length > 0 ? { serialTruncated: truncated } : {}),
      problems: report.problems,
    };
  },
};

/** Specs one call runs at most. */
const MAX_SPECS = 200;

export const runTests: Tool<ToolContext> = {
  name: 'run_tests',
  title: 'Run test specs',
  description:
    'Runs Benchtop test specs (*.bench.json: a project, firmware per board, steps and assertions — the format `bench test` and CI use) from files or folders under the root, one after another. Returns each spec\'s result with its failed assertions, and the totals; specs left when the call\'s wall-clock budget runs out are listed as not run.',
  inputSchema: {
    type: 'object',
    properties: { paths: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 1024 }, description: 'Spec files or folders (searched recursively), relative to the root.' } },
    required: ['paths'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  run(args, context) {
    const files = discoverSpecs(args.paths as string[], context.io);
    if (files.length === 0) throw new ToolError(`no *.bench.json specs in ${(args.paths as string[]).join(', ')}`);
    if (files.length > MAX_SPECS) throw new ToolError(`${files.length} specs: run at most ${MAX_SPECS} per call`);
    const start = context.io.now();
    const specs: object[] = [];
    const notRun: string[] = [];
    let passed = 0;
    let failed = 0;
    let errors = 0;
    for (const file of files) {
      if (context.io.now() - start > context.limits.maxWallMs) {
        notRun.push(file);
        continue;
      }
      const left = context.limits.maxWallMs - (context.io.now() - start);
      let name = defaultSpecName(file);
      let report: RunReport;
      try {
        const spec = loadSpec(context.io, file);
        name = spec.name;
        report = runHeadless({ ...spec.options, maxDurationNs: context.limits.maxSimNs, maxWallMs: left }, context.io);
      } catch (error) {
        report = { ok: false, exitCode: 2, simulatedNs: 0, wallMs: 0, simulatedMHz: 0, assertions: [], serial: {}, problems: [], error: error instanceof Error ? error.message : String(error) };
      }
      if (report.exitCode === 0) passed++;
      else if (report.exitCode === 1) failed++;
      else errors++;
      specs.push({
        file,
        name,
        ok: report.ok,
        ...(report.error === null ? {} : { error: report.error }),
        assertions: `${report.assertions.filter((a) => a.ok).length}/${report.assertions.length}`,
        ...(report.ok ? {} : { failed: report.assertions.filter((a) => !a.ok) }),
        simulated: timeText(report.simulatedNs),
        wallMs: report.wallMs,
      });
    }
    return { ok: failed === 0 && errors === 0 && notRun.length === 0, passed, failed, errors, ...(notRun.length > 0 ? { notRun } : {}), specs };
  },
};
