import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../packages/core/src/firmware/fixtures.test-helper.ts';

// The only proof that the CLI runs under plain Node type stripping (vitest transpiles on its
// own): spawn `node apps/cli/src/main.ts` with no flags, no loader and no NODE_OPTIONS.

function cli(command: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ['apps/cli/src/main.ts', command, ...args], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const bench = (...args: string[]) => cli('run', ...args);

const BASE = ['fixtures/projects/cli-demo.json', '--firmware', 'uno=fixtures/firmware/uno/cli-demo.hex'];

describe('benchtop run (spawned node)', () => {
  it('exits 0, 1 and 2', () => {
    const pass = bench(...BASE, '--expect', 'pin uno:13 is 1 at 1500ms');
    expect(pass.stderr).toMatch(/^ok — 1\/1 assertions passed/m);
    expect(pass.status).toBe(0);
    expect(JSON.parse(pass.stdout)).toMatchObject({ ok: true, exitCode: 0, simulatedNs: 1.5e9 });

    const fail = bench(...BASE, '--expect', 'pin uno:13 is 1 at 500ms');
    expect(fail.status).toBe(1);
    expect(JSON.parse(fail.stdout).assertions[0]).toMatchObject({ ok: false, detail: 'level 0' });
    expect(fail.stderr).toMatch(/FAILED — 0\/1 .*first failure: pin uno:13 is 1 at 500ms \(level 0\)/);

    const missing = bench('fixtures/projects/cli-demo.json', '--firmware', 'uno=fixtures/firmware/uno/nope.hex', '--duration', '1s');
    expect(missing.status).toBe(2);
    expect(JSON.parse(missing.stdout).error).toMatch(/cannot read firmware/);

    const usage = bench('--duration');
    expect(usage.status).toBe(2);
    expect(usage.stderr).toMatch(/usage: benchtop run/);
  }, 60_000);

  it('benchtop test: specs on worker threads under plain node, exits 0, 1 and 2, writes the reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'benchtop-specs-'));
    try {
      const pass = cli('test', 'fixtures/specs/blink.bench.json', 'fixtures/specs/button.bench.json', '--jobs', '2', '--junit', join(dir, 'out.xml'), '--markdown', join(dir, 'out.md'));
      expect(pass.stdout).toMatch(/^2 specs: 2 passed, 0 failed, 0 errors — 9\/9 assertions passed/m);
      expect(pass.status).toBe(0);
      expect(spawnSync('grep', ['-c', '<testcase ', join(dir, 'out.xml')], { encoding: 'utf8' }).stdout.trim()).toBe('9');

      writeFileSync(
        join(dir, 'fail.bench.json'),
        JSON.stringify({ project: join(REPO_ROOT, 'fixtures/projects/blink-led.json'), firmware: { uno: join(REPO_ROOT, 'fixtures/firmware/uno/blink.hex') }, expect: ['pin uno:13 is 0 at 250ms'] }),
      );
      const fail = cli('test', dir);
      expect(fail.stdout).toMatch(/^FAIL  fail — 0\/1 assertions/m);
      expect(fail.status).toBe(1);

      const usage = cli('test', 'README.md');
      expect(usage.status).toBe(2);
      expect(usage.stderr).toMatch(/README\.md: not a folder or a \*\.bench\.json spec/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('benchtop mcp (spawned node)', () => {
  it('serves MCP on stdio under plain node: initialize, then a run_simulation, stdout only protocol lines', () => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'spawn-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_simulation', arguments: { project: 'fixtures/projects/blink-led.json', firmware: { uno: 'fixtures/firmware/uno/blink.hex' }, expect: ['pin uno:13 is 1 at 250ms'] } } },
    ];
    // Run from another folder: --root, not the working folder, decides where paths point.
    const result = spawnSync(process.execPath, [join(REPO_ROOT, 'apps/cli/src/main.ts'), 'mcp', '--root', REPO_ROOT], {
      cwd: tmpdir(),
      env,
      input: `${messages.map((m) => JSON.stringify(m)).join('\n')}\n`,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).toBe(0);
    const replies = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { id: number; result: { protocolVersion?: string; structuredContent?: { ok: boolean } } });
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
    expect(replies[0].result.protocolVersion).toBe('2025-06-18');
    expect(replies[1].result.structuredContent?.ok).toBe(true);
  }, 60_000);
});
