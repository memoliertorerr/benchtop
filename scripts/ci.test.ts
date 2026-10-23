import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Manifest } from './fixture-boards.ts';

// BT95: the GitHub Actions workflow, checked line by line (the repository has no YAML parser and
// adds none): it must run the whole verify, with pinned actions, read-only permissions, every
// download checked against a pinned SHA-256, and the tool versions the fixtures were built with.
const ROOT = join(import.meta.dirname, '..');
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'verify.yml'), 'utf8');
const lines = workflow.split('\n');
const manifest = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'firmware', 'manifest.json'), 'utf8')) as Manifest;
const env = (name: string): string => {
  const line = lines.find((l) => l.trim().startsWith(`${name}:`));
  if (line === undefined) throw new Error(`no ${name} in the workflow`);
  return line.split(':').slice(1).join(':').trim();
};

describe('the CI workflow (.github/workflows/verify.yml)', () => {
  it('runs the whole npm run verify on pushes to main and on pull requests', () => {
    expect(lines.filter((l) => /^\s+run: npm run verify\s*$/.test(l))).toHaveLength(1);
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:$/m);
    // Nothing narrower stands in for it: no test filters, no skipped stages.
    expect(workflow).not.toMatch(/vitest run |npm (?:run )?test\b|--project|--skip|continue-on-error/);
  });

  it('pins every action to a commit SHA, named by its release', () => {
    const uses = lines.filter((l) => /^\s+(?:- )?uses:/.test(l));
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const line of uses) expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  it('asks for read-only permissions and keeps no credentials in the checkout', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).not.toMatch(/: write\b/);
    expect(workflow).toMatch(/persist-credentials: false/);
  });

  it('checks every download against a SHA-256 before using it', () => {
    const curls = lines.map((l, i) => [l, i] as const).filter(([l]) => /\bcurl\b/.test(l));
    expect(curls.length).toBe(2);
    for (const [line, i] of curls) {
      const file = /-o (\S+)/.exec(line)?.[1];
      expect(file, line).toBeDefined();
      expect(lines[i + 1]).toContain(`sha256sum -c -`);
      expect(lines[i + 1]).toContain(file as string);
    }
    expect(env('ARDUINO_CLI_SHA256')).toMatch(/^[0-9a-f]{64}$/);
    expect(env('XTENSA_SHA256')).toMatch(/^[0-9a-f]{64}$/);
    // The fetch scripts verify their own pinned hashes; CI only says yes.
    for (const script of ['fetch:esp32-rom', 'fetch:rp2350-rom', 'fetch:micropython']) expect(workflow).toContain(`npm run ${script} -- --yes`);
  });

  it('uses the arduino-cli and AVR core the committed fixtures were built with', () => {
    expect(env('ARDUINO_CLI_VERSION')).toBe(manifest.arduinoCli);
    expect(env('ARDUINO_AVR_CORE')).toBe(`arduino:avr@${manifest.cores['arduino:avr']}`);
    // The toolchain the esp32 core of the fixtures uses (esp32:esp32@2.0.17 → esp-2021r2-patch5).
    expect(manifest.cores['esp32:esp32']).toBe('2.0.17');
    expect(env('XTENSA_URL')).toContain('esp-2021r2-patch5');
  });

  it('runs on a Node the package accepts', () => {
    const engines = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { engines: { node: string } }).engines.node;
    const min = Number(/>=(\d+)/.exec(engines)?.[1]);
    const node = /node-version: (\d+)\.\d+\.\d+/.exec(workflow)?.[1];
    expect(Number(node)).toBeGreaterThanOrEqual(min);
  });

  it('names nothing internal (it is published)', () => {
    expect(workflow).not.toMatch(/(^|[^A-Za-z0-9_])BT[0-9]+|BUILD_PLAN|[Bb]uild plan|AGENTS?\.md|CLAUDE\.md|bt-step|HUMAN_CHECKS/);
  });
});
