/**
 * Suite reports for CI (BT48). JUnit XML — the format CI systems read for test results — has one
 * <testsuite> per spec and one <testcase> per assertion: a failed assertion is a <failure> whose
 * message is what was seen; a spec that couldn't run is one "run" testcase with an <error>. Each
 * suite's serial output goes to <system-out> (each board's first 64 KiB, CRLF as LF) and its problems to
 * <system-err>. Times are wall seconds, so they differ run to run; everything else is
 * deterministic. The Markdown report (a CI job summary) has no wall times at all.
 */

import type { SpecResult, SuiteReport } from './suite.ts';
import { formatNs } from './run.ts';

/** Serial characters per board a JUnit report keeps. */
export const JUNIT_SERIAL_CAP = 64 * 1024;

/** Text as XML 1.0 character data or attribute value: escaped, with characters XML forbids as U+FFFD. */
export function xmlText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3);

function testsuite(spec: SpecResult): string {
  const r = spec.report;
  const name = xmlText(spec.name);
  const lines: string[] = [];
  if (r.exitCode === 2) {
    lines.push(`  <testsuite name="${name}" file="${xmlText(spec.file)}" tests="1" failures="0" errors="1" time="${seconds(r.wallMs)}">`);
    lines.push(`    <testcase name="run" classname="${name}" time="${seconds(r.wallMs)}">`);
    lines.push(`      <error message="${xmlText(r.error ?? 'unknown error')}" type="error"/>`);
    lines.push('    </testcase>');
    lines.push('  </testsuite>');
    return lines.join('\n');
  }
  const failures = r.assertions.filter((a) => !a.ok).length;
  lines.push(`  <testsuite name="${name}" file="${xmlText(spec.file)}" tests="${r.assertions.length}" failures="${failures}" errors="0" time="${seconds(r.wallMs)}">`);
  lines.push('    <properties>');
  lines.push(`      <property name="simulated" value="${xmlText(formatNs(r.simulatedNs))}"/>`);
  lines.push('    </properties>');
  for (const a of r.assertions) {
    const head = `    <testcase name="${xmlText(a.text)}" classname="${name}" time="0"`;
    if (a.ok) lines.push(`${head}/>`);
    else {
      lines.push(`${head}>`);
      lines.push(`      <failure message="${xmlText(a.detail)}" type="assertion">${xmlText(`${a.text}: ${a.detail}`)}</failure>`);
      lines.push('    </testcase>');
    }
  }
  const boards = Object.keys(r.serial).sort();
  if (boards.length > 0) {
    // Serial.println's CRLF as plain newlines (XML parsers would normalize a raw CR anyway).
    const out = boards.map((b) => `--- ${b} ---\n${r.serial[b].slice(0, JUNIT_SERIAL_CAP).replace(/\r\n?/g, '\n')}`).join('\n');
    lines.push(`    <system-out>${xmlText(out)}</system-out>`);
  }
  if (r.problems.length > 0) {
    lines.push(`    <system-err>${xmlText(r.problems.map((p) => `${p.severity} ${p.code} [${p.parts.join(', ')}]: ${p.message}`).join('\n'))}</system-err>`);
  }
  lines.push('  </testsuite>');
  return lines.join('\n');
}

export function junitXml(report: SuiteReport): string {
  const tests = report.specs.reduce((n, s) => n + (s.report.exitCode === 2 ? 1 : s.report.assertions.length), 0);
  const failures = report.specs.reduce((n, s) => n + s.report.assertions.filter((a) => !a.ok).length, 0);
  const errors = report.specs.filter((s) => s.report.exitCode === 2).length;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="benchtop" tests="${tests}" failures="${failures}" errors="${errors}" time="${seconds(report.wallMs)}">`,
    ...report.specs.map(testsuite),
    '</testsuites>',
    '',
  ].join('\n');
}

/** Text for a Markdown table cell or list item: one line, pipes escaped. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/** Plain text in Markdown: also no HTML (GitHub would read "<on purpose>" as a tag). */
function plain(text: string): string {
  return cell(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/** Inline code that survives backticks inside. */
function code(text: string): string {
  const fence = text.includes('`') ? '``' : '`';
  return `${fence}${fence === '``' ? ' ' : ''}${cell(text)}${fence === '``' ? ' ' : ''}${fence}`;
}

export function markdownReport(report: SuiteReport): string {
  const assertions = report.specs.flatMap((s) => s.report.assertions);
  const passed = assertions.filter((a) => a.ok).length;
  const errors = report.specs.filter((s) => s.report.exitCode === 2).length;
  const verdict = report.exitCode === 0 ? 'all passed' : report.exitCode === 1 ? 'failures' : errors === 1 ? '1 spec could not run' : `${errors} specs could not run`;
  const out = [`## Benchtop: ${report.specs.length} specs, ${passed}/${assertions.length} assertions — ${verdict}`, '', '| | Spec | Assertions | Simulated |', '|---|---|---|---|'];
  for (const s of report.specs) {
    const r = s.report;
    const mark = r.exitCode === 0 ? '✅' : r.exitCode === 1 ? '❌' : '⚠️';
    const counts = r.exitCode === 2 ? 'did not run' : `${r.assertions.filter((a) => a.ok).length}/${r.assertions.length}`;
    out.push(`| ${mark} | ${plain(s.name)} | ${counts} | ${r.exitCode === 2 ? '—' : formatNs(r.simulatedNs)} |`);
  }
  for (const s of report.specs) {
    const r = s.report;
    if (r.exitCode === 0) continue;
    out.push('', `### ${r.exitCode === 2 ? '⚠️' : '❌'} ${plain(s.name)} (${code(s.file)})`, '');
    if (r.exitCode === 2) out.push(`- ${plain(r.error ?? 'unknown error')}`);
    for (const a of r.assertions) if (!a.ok) out.push(`- ${code(a.text)} — ${plain(a.detail)}`);
    for (const p of r.problems) if (p.severity === 'error') out.push(`- problem: ${code(p.code)} — ${plain(p.message)}`);
  }
  out.push('');
  return out.join('\n');
}
