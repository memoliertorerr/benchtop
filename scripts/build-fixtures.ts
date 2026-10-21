/**
 * Builds every fixture sketch with the local arduino-cli and commit-ready outputs:
 *   fixtures/sketches/<board>/<name>/<name>.ino → fixtures/firmware/<board>/<name>.<ext>
 * plus fixtures/firmware/manifest.json (hashes, sizes, CLI/core/library versions).
 *
 *   node scripts/build-fixtures.ts                 build everything, rewrite the manifest
 *   node scripts/build-fixtures.ts --only uno/blink build one sketch, update its entries
 *   node scripts/build-fixtures.ts --check         rebuild into a temp dir and compare hashes
 *                                                  with the manifest; writes nothing
 *
 * Each sketch builds in a FIXED build path (fixtures/.build/<board>/<name>), because the ELF's
 * debug info embeds it: the same path gives byte-identical outputs on every run.
 *
 * Sketches in ADDR2LINE_ORACLES also get <name>.addr2line.txt from the local avr-addr2line:
 * one "0x<addr> <basename>:<line>" line per FUNC symbol start and per 64th byte of .text.
 * Boards with `symbols` (ESP32) also get <name>.syms.tsv from the toolchain's nm, because their
 * full ELF isn't committed.
 *
 * A full run (no --only) then builds the Xtensa test programs (scripts/xtensa-programs.ts) and
 * the decode corpora (scripts/xtensa-corpus.ts, which reads serial-hello's ELF from its build
 * folder); `--only xtensa/<name>` or `--only xtensa/corpus` builds just those.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSection, parseElf32 } from '../packages/core/src/firmware/elf.ts';
import { arduinoCliCandidates, findArduinoCli, findAvrTool, findXtensaTool, runArduinoCli } from './arduino-cli.ts';
import { ADDR2LINE_ORACLES, FIXTURE_BOARDS, type Manifest, type ManifestOutput, sketchSourceSha256 } from './fixture-boards.ts';
import { writeCorpora } from './xtensa-corpus.ts';
import { buildPrograms } from './xtensa-programs.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKETCHES = join(ROOT, 'fixtures', 'sketches');
const FIRMWARE = join(ROOT, 'fixtures', 'firmware');
const BUILD = join(ROOT, 'fixtures', '.build');
const MANIFEST = join(FIRMWARE, 'manifest.json');

interface Sketch {
  board: string;
  name: string;
  dir: string;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
  const known = new Set(['--check', '--only', ...(only === undefined ? [] : [only])]);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length > 0 || (onlyIndex >= 0 && only === undefined)) {
    console.error(`usage: node scripts/build-fixtures.ts [--only <board>/<name> | --only xtensa/<name> | --only xtensa/corpus] [--check]`);
    return 1;
  }

  // Xtensa test programs and decode corpora (BT27): no arduino-cli involved.
  if (only?.startsWith('xtensa/')) {
    const target = only.slice('xtensa/'.length);
    const mismatches = target === 'corpus' ? writeCorpora(check) : buildPrograms(check, target);
    return mismatches === 0 ? 0 : 1;
  }

  const cli = findArduinoCli();
  if (cli === undefined) {
    console.error(`arduino-cli not found. Looked in:\n  ${arduinoCliCandidates().join('\n  ')}`);
    return 1;
  }

  const sketches = listSketches().filter((s) => only === undefined || `${s.board}/${s.name}` === only);
  if (sketches.length === 0) {
    console.error(only === undefined ? 'no sketches under fixtures/sketches/' : `no sketch ${only}`);
    return 1;
  }

  const tools = await toolVersions(cli);
  const previous = existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest) : undefined;
  if (check && previous === undefined) {
    console.error('--check needs fixtures/firmware/manifest.json; run without --check first');
    return 1;
  }

  const built: ManifestOutput[] = [];
  let failures = 0;
  let totalMs = 0;
  for (const sketch of sketches) {
    const board = FIXTURE_BOARDS[sketch.board];
    const outDir = mkdtempSync(join(tmpdir(), 'benchtop-fixture-'));
    const start = performance.now();
    try {
      const result = await runArduinoCli(cli, [
        'compile',
        '--fqbn',
        board.fqbn,
        '--build-path',
        join(BUILD, sketch.board, sketch.name),
        '--output-dir',
        outDir,
        '--json',
        '--no-color',
        sketch.dir,
      ]);
      const ms = performance.now() - start;
      totalMs += ms;
      const report = parseCompileJson(result.stdout);
      if (result.code !== 0 || report === undefined || report.success !== true) {
        failures++;
        console.error(`${sketch.board}/${sketch.name}: compile FAILED (exit ${result.code})`);
        console.error(report?.compiler_err || result.stderr || result.stdout);
        continue;
      }
      const platform = report.builder_result?.build_platform;
      const sourceSha256 = sketchSourceSha256(sketch.dir);
      const libraries: Record<string, string> = {};
      for (const lib of report.builder_result?.used_libraries ?? []) libraries[lib.name] = lib.version ?? '';
      for (const output of board.outputs) {
        const source = join(outDir, `${sketch.name}.ino.${output.from}`);
        const bytes = readFileSync(source);
        const file = `${sketch.board}/${sketch.name}.${output.ext}`;
        built.push({
          board: sketch.board,
          name: sketch.name,
          fqbn: board.fqbn,
          file,
          sha256: sha256(bytes),
          bytes: bytes.length,
          core: `${platform?.id ?? '?'}@${platform?.version ?? '?'}`,
          libraries: sortKeys(libraries),
          source: sourceSha256,
        });
        if (!check) {
          mkdirSync(join(FIRMWARE, sketch.board), { recursive: true });
          copyFileSync(source, join(FIRMWARE, file));
        }
      }
      if (board.symbols !== undefined) {
        const text = symbolTable(board.symbols, join(outDir, `${sketch.name}.ino.elf`));
        const file = `${sketch.board}/${sketch.name}.syms.tsv`;
        const bytes = Buffer.from(text, 'utf8');
        built.push({
          board: sketch.board,
          name: sketch.name,
          fqbn: board.fqbn,
          file,
          sha256: sha256(bytes),
          bytes: bytes.length,
          core: `${platform?.id ?? '?'}@${platform?.version ?? '?'}`,
          libraries: sortKeys(libraries),
          source: sourceSha256,
        });
        if (!check) writeFileSync(join(FIRMWARE, file), bytes);
      }
      if (ADDR2LINE_ORACLES.includes(`${sketch.board}/${sketch.name}`)) {
        const text = addr2lineOracle(join(outDir, `${sketch.name}.ino.elf`));
        const file = `${sketch.board}/${sketch.name}.addr2line.txt`;
        const bytes = Buffer.from(text, 'utf8');
        built.push({
          board: sketch.board,
          name: sketch.name,
          fqbn: board.fqbn,
          file,
          sha256: sha256(bytes),
          bytes: bytes.length,
          core: `${platform?.id ?? '?'}@${platform?.version ?? '?'}`,
          libraries: sortKeys(libraries),
          source: sourceSha256,
        });
        if (!check) writeFileSync(join(FIRMWARE, file), bytes);
      }
      console.info(`${sketch.board}/${sketch.name}: ${(ms / 1000).toFixed(1)} s`);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
  console.info(`compiled ${sketches.length - failures}/${sketches.length} sketches in ${(totalMs / 1000).toFixed(1)} s`);
  if (failures > 0) return 1;

  if (check) {
    const expected = new Map((previous as Manifest).outputs.map((o) => [o.file, o.sha256]));
    let mismatches = 0;
    for (const output of built) {
      const want = expected.get(output.file);
      const same = want === output.sha256;
      if (!same) mismatches++;
      console.info(`${same ? 'same   ' : 'CHANGED'} ${output.sha256}  ${output.file}`);
    }
    if (only === undefined) mismatches += buildPrograms(true) + writeCorpora(true);
    console.info(mismatches === 0 ? 'check: every output is byte-identical to the manifest' : `check: ${mismatches} output(s) differ`);
    return mismatches === 0 ? 0 : 1;
  }

  const rebuilt = new Set(built.map((o) => o.file));
  const kept = only === undefined ? [] : (previous?.outputs ?? []).filter((o) => !rebuilt.has(o.file));
  const manifest: Manifest = {
    ...tools,
    outputs: [...kept, ...built].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  if (only === undefined) {
    buildPrograms(false);
    writeCorpora(false);
  }
  console.info(`wrote ${MANIFEST.slice(ROOT.length + 1)}; fixtures/firmware is ${formatBytes(dirSize(FIRMWARE))}`);
  return 0;
}

/**
 * The addr2line oracle for an AVR ELF: every FUNC symbol start plus every 64th byte of .text,
 * each resolved by avr-addr2line to "<basename>:<line>" ("??:0" kept as is; a discriminator
 * suffix dropped).
 */
function addr2lineOracle(elfPath: string): string {
  const tool = findAvrTool('avr-addr2line');
  if (tool === undefined) throw new Error('avr-addr2line not found (set BENCHTOP_AVR_BIN to the avr-gcc bin folder)');
  const elf = parseElf32(readFileSync(elfPath));
  const addresses = new Set<number>();
  for (const symbol of elf.symbols) if (symbol.type === 'FUNC' && symbol.shndx !== 0 && symbol.shndx < 0xff00) addresses.add(symbol.value);
  const text = findSection(elf, '.text');
  if (text === undefined) throw new Error(`${elfPath}: no .text`);
  for (let a = text.addr; a < text.addr + text.size; a += 64) addresses.add(a);
  const sorted = [...addresses].sort((a, b) => a - b);
  const hex = sorted.map((a) => `0x${a.toString(16).padStart(4, '0')}`);
  const out = execFileSync(tool, ['-e', elfPath, ...hex], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n');
  const lines = sorted.map((_, i) => {
    const raw = (out[i] ?? '').replace(/ \(discriminator \d+\)$/, '').trim();
    if (raw.startsWith('??')) return raw;
    const colon = raw.lastIndexOf(':');
    return `${basename(raw.slice(0, colon))}:${raw.slice(colon + 1)}`;
  });
  return hex.map((h, i) => `${h} ${lines[i]}\n`).join('');
}

/** `nm -S -n --defined-only` of an ELF as "addr\tsize\ttype\tname" lines (size empty when nm has none). */
function symbolTable(nmName: string, elfPath: string): string {
  const nm = findXtensaTool(nmName) ?? findAvrTool(nmName);
  if (nm === undefined) throw new Error(`${nmName} not found (set BENCHTOP_XTENSA_BIN to the toolchain's bin folder)`);
  const out = execFileSync(nm, ['-S', '-n', '--defined-only', elfPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rows: string[] = [];
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 4) rows.push(parts.join('\t'));
    else if (parts.length === 3) rows.push(`${parts[0]}\t\t${parts[1]}\t${parts[2]}`);
  }
  return `${rows.join('\n')}\n`;
}

function listSketches(): Sketch[] {
  const sketches: Sketch[] = [];
  for (const board of readdirSync(SKETCHES).sort()) {
    if (!statSync(join(SKETCHES, board)).isDirectory()) continue;
    if (FIXTURE_BOARDS[board] === undefined) throw new Error(`fixtures/sketches/${board}: no FQBN for this board folder`);
    for (const name of readdirSync(join(SKETCHES, board)).sort()) {
      const dir = join(SKETCHES, board, name);
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, `${name}.ino`))) throw new Error(`fixtures/sketches/${board}/${name}: missing ${name}.ino`);
      sketches.push({ board, name, dir });
    }
  }
  return sketches;
}

async function toolVersions(cli: string): Promise<Omit<Manifest, 'outputs'>> {
  const version = JSON.parse((await runArduinoCli(cli, ['version', '--json'])).stdout) as { VersionString?: string };
  const cores = JSON.parse((await runArduinoCli(cli, ['core', 'list', '--json'])).stdout) as {
    platforms?: { id: string; installed_version?: string }[];
  };
  const libs = JSON.parse((await runArduinoCli(cli, ['lib', 'list', '--json'])).stdout) as {
    installed_libraries?: { library: { name: string; version?: string } }[];
  };
  const coreMap: Record<string, string> = {};
  for (const p of cores.platforms ?? []) coreMap[p.id] = p.installed_version ?? '';
  const libMap: Record<string, string> = {};
  for (const l of libs.installed_libraries ?? []) libMap[l.library.name] = l.library.version ?? '';
  return { arduinoCli: version.VersionString ?? '', cores: sortKeys(coreMap), libraries: sortKeys(libMap) };
}

interface CompileJson {
  success?: boolean;
  compiler_err?: string;
  builder_result?: {
    build_platform?: { id?: string; version?: string };
    used_libraries?: { name: string; version?: string }[];
  };
}

function parseCompileJson(stdout: string): CompileJson | undefined {
  try {
    return JSON.parse(stdout) as CompileJson;
  } catch {
    return undefined;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(path) : statSync(path).size;
  }
  return total;
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;
}

process.exitCode = await main();
