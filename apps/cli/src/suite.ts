/**
 * `benchtop test` (BT48): finds `*.bench.json` specs, runs each as `run` would — in parallel
 * worker threads (node:worker_threads, one spec at a time per worker; `--jobs 1` runs them
 * in-process) — and reports the suite: a line per spec, JUnit XML and Markdown (reports.ts), and
 * an exit code like `run`'s: 2 if a spec couldn't run (usage, load or run error), else 1 if an
 * assertion failed, else 0. Results come back in discovery order whatever order workers finish.
 */

import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { type CliIo, UsageError } from './load.ts';
import { formatNs, type RunReport, runHeadless } from './run.ts';
import { defaultSpecName, loadSpec, SPEC_SUFFIX } from './spec.ts';

export interface SuiteIo extends CliIo {
  isDirectory(path: string): boolean;
  /** A folder's entries (names, not paths). */
  list(dir: string): { name: string; directory: boolean }[];
}

export interface SpecResult {
  file: string;
  name: string;
  report: RunReport;
}

export interface SuiteReport {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  wallMs: number;
  specs: SpecResult[];
}

export interface TestOptions {
  paths: string[];
  jobs: number;
  junit?: string | undefined;
  markdown?: string | undefined;
  report?: string | undefined;
}

/** Default workers: all cores but one (the main thread collects). */
export function defaultJobs(): number {
  return Math.max(1, availableParallelism() - 1);
}

/** `test` arguments: <spec|dir>… [--jobs N] [--junit f] [--markdown f] [--report f]. */
export function parseTestArgs(argv: readonly string[]): TestOptions {
  const options: TestOptions = { paths: [], jobs: defaultJobs() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    if (arg === '--jobs') {
      const v = value();
      if (!/^[1-9]\d{0,2}$/.test(v)) throw new UsageError(`--jobs wants a whole number from 1, got "${v}"`);
      options.jobs = Number(v);
    } else if (arg === '--junit') options.junit = value();
    else if (arg === '--markdown') options.markdown = value();
    else if (arg === '--report') options.report = value();
    else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else options.paths.push(arg);
  }
  if (options.paths.length === 0) throw new UsageError('no spec files or folders given');
  return options;
}

/** Every spec under the paths: files as given, folders searched (skipping node_modules and dot folders), each once, sorted per folder. */
export function discoverSpecs(paths: readonly string[], io: SuiteIo): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    const entries = io.list(dir).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = `${dir.replace(/\/+$/, '')}/${entry.name}`;
      if (entry.directory) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(path);
      } else if (entry.name.endsWith(SPEC_SUFFIX)) found.push(path);
    }
  };
  for (const path of paths) {
    if (io.isDirectory(path)) walk(path);
    else if (path.endsWith(SPEC_SUFFIX)) found.push(path);
    else throw new UsageError(`${path}: not a folder or a *${SPEC_SUFFIX} spec`);
  }
  return [...new Set(found)];
}

function errored(file: string, name: string, message: string): SpecResult {
  const report: RunReport = { ok: false, exitCode: 2, simulatedNs: 0, wallMs: 0, simulatedMHz: 0, assertions: [], serial: {}, problems: [], error: message };
  return { file, name, report };
}

/** One spec, in this thread. Never throws. */
export function runSpecFile(file: string, io: CliIo): SpecResult {
  try {
    const spec = loadSpec(io, file);
    return { file, name: spec.name, report: runHeadless(spec.options, io) };
  } catch (error) {
    return errored(file, defaultSpecName(file), error instanceof Error ? error.message : String(error));
  }
}

/** Runs the specs on `jobs` workers (in-process for 1) and collects the suite report. */
export async function runSuite(files: readonly string[], io: CliIo, jobs: number): Promise<SuiteReport> {
  const start = io.now();
  const results: (SpecResult | undefined)[] = new Array(files.length);
  if (jobs <= 1 || files.length <= 1) files.forEach((file, i) => (results[i] = runSpecFile(file, io)));
  else await runInWorkers(files, Math.min(jobs, files.length), results);
  const specs = results.map((r, i) => r ?? errored(files[i], defaultSpecName(files[i]), 'not run: its worker stopped'));
  const exitCode = specs.reduce<0 | 1 | 2>((code, s) => (s.report.exitCode > code ? s.report.exitCode : code), 0);
  return { ok: exitCode === 0, exitCode, wallMs: Math.round((io.now() - start) * 10) / 10, specs };
}

function runInWorkers(files: readonly string[], count: number, results: (SpecResult | undefined)[]): Promise<void> {
  const url = new URL('./suite-worker.ts', import.meta.url);
  let next = 0;
  const one = (): Promise<void> =>
    new Promise((done) => {
      const worker = new Worker(url);
      let current = -1;
      const feed = (): void => {
        if (next >= files.length) {
          current = -1;
          void worker.terminate();
          return;
        }
        current = next++;
        worker.postMessage(files[current]);
      };
      worker.on('message', (result: SpecResult) => {
        results[current] = result;
        feed();
      });
      worker.on('error', (error) => {
        if (current >= 0) results[current] = errored(files[current], defaultSpecName(files[current]), `worker failed: ${error.message}`);
        current = -1;
      });
      worker.on('exit', () => done());
      feed();
    });
  return Promise.all(Array.from({ length: count }, one)).then(() => undefined);
}

/** One line per spec, for the terminal. */
export function specLine(spec: SpecResult): string {
  const r = spec.report;
  if (r.exitCode === 2) return `ERROR ${spec.name} — ${r.error ?? 'unknown error'}`;
  const passed = r.assertions.filter((a) => a.ok).length;
  const head = `${r.ok ? 'ok   ' : 'FAIL '} ${spec.name} — ${passed}/${r.assertions.length} assertions, ${formatNs(r.simulatedNs)} simulated in ${(r.wallMs / 1000).toFixed(2)} s`;
  const failed = r.assertions.find((a) => !a.ok);
  return failed === undefined ? head : `${head}; first failure: ${failed.text} (${failed.detail})`;
}

/** The closing line. */
export function suiteLine(report: SuiteReport): string {
  const count = (code: number) => report.specs.filter((s) => s.report.exitCode === code).length;
  const assertions = report.specs.flatMap((s) => s.report.assertions);
  return `${report.specs.length} specs: ${count(0)} passed, ${count(1)} failed, ${count(2)} errors — ${assertions.filter((a) => a.ok).length}/${assertions.length} assertions passed in ${(report.wallMs / 1000).toFixed(2)} s`;
}
