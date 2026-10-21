import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { UsageError } from './load.ts';
import { nodeIo } from './node-io.ts';
import { junitXml, markdownReport, xmlText } from './reports.ts';
import { parseSpec } from './spec.ts';
import { discoverSpecs, parseTestArgs, runSuite, type SuiteIo, type SuiteReport } from './suite.ts';

// BT48: test specs, the suite runner and its reports. The fixture suite (fixtures/specs/) runs
// in-process and on worker threads; its reports match the committed golden files (JUnit times
// normalized: they are wall seconds).

/** Real files, plus in-memory ones (specs a test writes), relative to the repository. */
function filesIo(extra: Record<string, string> = {}): SuiteIo {
  return {
    ...nodeIo,
    readFile: (path) => (Object.hasOwn(extra, path) ? new TextEncoder().encode(extra[path]) : new Uint8Array(readFileSync(join(REPO_ROOT, path)))),
  };
}

const normalized = (xml: string): string => xml.replace(/ time="[\d.]+"/g, ' time="0"');
const goldenPath = (name: string): string => join(REPO_ROOT, 'fixtures', 'specs', 'golden', name);
/** The committed golden report — or, with UPDATE_GOLDEN=1, `actual` written over it (review the diff). */
function golden(name: string, actual: string): string {
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(goldenPath(name), actual);
  return readFileSync(goldenPath(name), 'utf8');
}

/**
 * XML 1.0 well-formedness, enough for our output: one declaration, balanced and properly nested
 * elements, quoted attributes, no raw '<' or stray '&' in text, no forbidden characters.
 */
function wellFormed(xml: string): void {
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')) throw new Error('no XML declaration');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)) throw new Error('forbidden control character');
  const body = xml.slice(xml.indexOf('\n') + 1);
  const stack: string[] = [];
  const token = /<(\/?)([A-Za-z][\w-]*)((?:\s+[\w-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/gy;
  let roots = 0;
  for (let m = token.exec(body); m !== null && m.index < body.length; m = token.exec(body)) {
    if (m[6] !== undefined) throw new Error(`raw '<' at ${m.index}: ${body.slice(m.index, m.index + 40)}`);
    if (m[5] !== undefined) {
      if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(m[5])) throw new Error(`stray '&' in text: ${m[5].slice(0, 40)}`);
      if (stack.length === 0 && m[5].trim() !== '') throw new Error('text outside the root');
      continue;
    }
    if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(m[3] ?? '')) throw new Error(`stray '&' in attributes of <${m[2]}>`);
    if (m[1] === '/') {
      if (stack.pop() !== m[2]) throw new Error(`</${m[2]}> closes the wrong element`);
    } else if (m[4] !== '/') {
      if (stack.length === 0) roots++;
      stack.push(m[2]);
    } else if (stack.length === 0) roots++;
  }
  if (stack.length > 0) throw new Error(`unclosed <${stack.at(-1)}>`);
  if (roots !== 1) throw new Error(`${roots} root elements`);
}

/** The in-process run of the fixture suite, which the worker-thread test compares against. */
let inProcess: SuiteReport | undefined;

describe('test specs (BT48)', () => {
  it('parses a spec: paths resolved against its folder, name defaulting to the file name', () => {
    const spec = parseSpec(
      { project: '../projects/p.json', firmware: { uno: 'fw/b.hex', esp: '/abs/e.bin' }, steps: [{ at: '1ms', serial: 'x' }], expect: ['pin uno:13 is 1 at 1ms'], duration: '2s' },
      'tests/specs/blink.bench.json',
    );
    expect(spec).toEqual({
      file: 'tests/specs/blink.bench.json',
      name: 'blink',
      options: {
        project: 'tests/projects/p.json',
        firmware: { uno: 'tests/specs/fw/b.hex', esp: '/abs/e.bin' },
        duration: '2s',
        expect: ['pin uno:13 is 1 at 1ms'],
        scriptJson: { steps: [{ at: '1ms', serial: 'x' }] },
      },
    });
    expect(parseSpec({ name: 'Named', project: 'p.json' }, 's.bench.json').name).toBe('Named');
  });

  it('refuses malformed specs with the file and the field', () => {
    const bad: [unknown, RegExp][] = [
      [[], /x\.bench\.json: a spec is a JSON object/],
      [{ project: 'p.json', expects: [] }, /x\.bench\.json: unknown field "expects"/],
      [{}, /"project" must be a non-empty string/],
      [{ project: 'p.json', firmware: ['a'] }, /"firmware" must map board ids/],
      [{ project: 'p.json', firmware: { uno: 3 } }, /"firmware\.uno" must be a non-empty string/],
      [{ project: 'p.json', steps: {} }, /"steps" must be an array/],
      [{ project: 'p.json', expect: [1] }, /"expect" must be an array of strings/],
      [{ project: 'p.json', duration: 5 }, /"duration" must be a non-empty string/],
    ];
    for (const [json, message] of bad) expect(() => parseSpec(json, 'x.bench.json')).toThrow(message);
    expect(() => parseSpec({}, 'x.bench.json')).toThrow(UsageError);
  });

  it('parses test arguments', () => {
    expect(parseTestArgs(['a', 'b.bench.json', '--jobs', '3', '--junit', 'j.xml', '--markdown', 'm.md', '--report', 'r.json'])).toEqual({
      paths: ['a', 'b.bench.json'],
      jobs: 3,
      junit: 'j.xml',
      markdown: 'm.md',
      report: 'r.json',
    });
    expect(() => parseTestArgs([])).toThrow(/no spec files or folders/);
    expect(() => parseTestArgs(['a', '--jobs', '0'])).toThrow(/--jobs wants a whole number/);
    expect(() => parseTestArgs(['a', '--jobs'])).toThrow(/--jobs needs a value/);
    expect(() => parseTestArgs(['a', '--fast'])).toThrow(/unknown option --fast/);
  });

  it('discovers specs: folders searched in name order, node_modules and dot folders skipped, files as given', () => {
    const tree: Record<string, { name: string; directory: boolean }[]> = {
      t: [
        { name: 'b.bench.json', directory: false },
        { name: 'sub', directory: true },
        { name: 'a.bench.json', directory: false },
        { name: 'notes.json', directory: false },
        { name: 'node_modules', directory: true },
        { name: '.git', directory: true },
      ],
      't/sub': [{ name: 'c.bench.json', directory: false }],
      't/node_modules': [{ name: 'x.bench.json', directory: false }],
      't/.git': [{ name: 'y.bench.json', directory: false }],
    };
    const io: SuiteIo = { ...nodeIo, isDirectory: (p) => Object.hasOwn(tree, p.replace(/\/$/, '')), list: (d) => tree[d.replace(/\/$/, '')] ?? [] };
    expect(discoverSpecs(['t/', 'one.bench.json', 't/a.bench.json'], io)).toEqual(['t/a.bench.json', 't/b.bench.json', 't/sub/c.bench.json', 'one.bench.json']);
    expect(() => discoverSpecs(['readme.md'], io)).toThrow(/readme\.md: not a folder or a \*\.bench\.json spec/);
  });

  it('runs the fixture suite in-process: every spec passes, and the reports match the golden files', async () => {
    const io = filesIo();
    // The five top-level specs (fixtures/specs/examples/ — every gallery example — runs in verify).
    const files = discoverSpecs(['fixtures/specs'], { ...io, isDirectory: (p) => nodeIo.isDirectory(join(REPO_ROOT, p)), list: (d) => nodeIo.list(join(REPO_ROOT, d)) }).filter(
      (f) => !f.includes('/examples/'),
    );
    expect(files).toEqual([
      'fixtures/specs/blink.bench.json',
      'fixtures/specs/button.bench.json',
      'fixtures/specs/dht22.bench.json',
      'fixtures/specs/serial-echo.bench.json',
      'fixtures/specs/two-boards.bench.json',
    ]);
    const report = await runSuite(files, io, 1);
    inProcess = report;
    expect(report.specs.map((s) => [s.name, s.report.exitCode, s.report.error])).toEqual(files.map(() => [expect.any(String), 0, null]));
    expect(report).toMatchObject({ ok: true, exitCode: 0 });
    const xml = junitXml(report);
    wellFormed(xml);
    expect(normalized(xml)).toBe(golden('suite.junit.xml', normalized(xml)));
    expect(markdownReport(report)).toBe(golden('suite.md', markdownReport(report)));
  });

  it('runs the same suite on worker threads with the same results, in discovery order', async () => {
    const files = discoverSpecs([join(REPO_ROOT, 'fixtures/specs')], nodeIo).filter((f) => !f.includes('/examples/'));
    const report = await runSuite(files, nodeIo, 3);
    expect(report.specs.map((s) => s.file)).toEqual(files);
    // Against the golden test's in-process run (or a fresh one when this test runs alone).
    const reference = inProcess ?? (await runSuite(files, nodeIo, 1));
    expect(report.specs.map((s) => [s.name, s.report.exitCode, s.report.assertions.map((a) => [a.text, a.ok, a.atNs])])).toEqual(
      reference.specs.map((s) => [s.name, s.report.exitCode, s.report.assertions.map((a) => [a.text, a.ok, a.atNs])]),
    );
    expect(report.exitCode).toBe(0);
  });

  it('reports a failed assertion (exit 1) and a spec that cannot run (exit 2) in JUnit and Markdown', async () => {
    const io = filesIo({
      'fixtures/specs/fail.bench.json': JSON.stringify({
        name: 'fails <on purpose> & says so',
        project: '../projects/blink-led.json',
        firmware: { uno: '../firmware/uno/blink.hex' },
        expect: ['pin uno:13 is 0 at 250ms', 'serial contains "goodbye" by 100ms', 'pin uno:13 is 0 at 750ms'],
      }),
      'fixtures/specs/broken.bench.json': JSON.stringify({ project: '../projects/blink-led.json', firmwares: {} }),
    });
    const failing = await runSuite(['fixtures/specs/fail.bench.json'], io, 1);
    expect(failing.exitCode).toBe(1);
    const both: SuiteReport = await runSuite(['fixtures/specs/fail.bench.json', 'fixtures/specs/broken.bench.json'], io, 1);
    expect(both.exitCode).toBe(2);
    const xml = junitXml(both);
    wellFormed(xml);
    expect(xml).toContain('<testsuites name="benchtop" tests="4" failures="2" errors="1"');
    expect(xml).toContain('<testsuite name="fails &lt;on purpose&gt; &amp; says so"');
    expect(xml).toContain('<failure message="level 1" type="assertion">pin uno:13 is 0 at 250ms: level 1</failure>');
    expect(xml).toContain('<failure message="not seen by 100 ms" type="assertion">');
    expect(xml).toContain('<testcase name="run" classname="broken"');
    expect(xml).toContain('<error message="fixtures/specs/broken.bench.json: unknown field &quot;firmwares&quot;');
    const md = markdownReport(both);
    expect(md).toContain('## Benchtop: 2 specs, 1/3 assertions — 1 spec could not run');
    expect(md).toContain('| ❌ | fails &lt;on purpose> &amp; says so | 1/3 | 750 ms |');
    expect(md).toContain('| ⚠️ | broken | did not run | — |');
    expect(md).toContain('### ❌ fails &lt;on purpose> &amp; says so (`fixtures/specs/fail.bench.json`)');
    expect(md).toContain('- fixtures/specs/broken.bench.json: unknown field "firmwares"');
    expect(md).toContain('- `pin uno:13 is 0 at 250ms` — level 1');
    expect(md).toContain('- `serial contains "goodbye" by 100ms` — not seen by 100 ms');
  });

  it('escapes XML text and replaces characters XML forbids', () => {
    expect(xmlText('a<b & "c" \'d\' >')).toBe('a&lt;b &amp; &quot;c&quot; &apos;d&apos; &gt;');
    expect(xmlText('bell\u0007 nul\u0000 tab\t ok\n lone\uD800 pair😀')).toBe('bell� nul� tab\t ok\n lone� pair😀');
  });
});
