import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { UsageError } from './load.ts';
import type { RunIo } from './run.ts';
import { parsePcbArgs, runPcb } from './pcb.ts';

// BT58: `benchtop pcb` — DRC and exports of a project's PCB, in-process and through a spawned node.

const io: RunIo = { readFile: (path) => readFileSync(resolve(REPO_ROOT, path)), now: () => performance.now() };

describe('benchtop pcb', () => {
  it('exports the committed layout: DRC clean, the files the fixture goldens hold', () => {
    const r = runPcb(parsePcbArgs(['fixtures/projects/blink-led.json', '--pcb', 'fixtures/pcb/blink.pcb.json', '--out', 'x', '--drc']), io);
    expect(r.exitCode).toBe(0);
    expect(r.lines).toEqual(['DRC: 0 errors, 0 warnings, 0 connections unrouted — 3 footprints, 3 nets']);
    const golden = readdirSync(join(REPO_ROOT, 'fixtures', 'pcb', 'golden')).sort();
    expect(r.files.map((f) => f.name.replace(/\//g, '__')).sort()).toEqual(golden);
    for (const f of r.files) expect(f.data).toBe(readFileSync(join(REPO_ROOT, 'fixtures', 'pcb', 'golden', f.name.replace(/\//g, '__')), 'utf8'));
  });

  it('seeds a layout when none is given; --drc fails on the breadboard layout’s overlaps', () => {
    const seeded = runPcb(parsePcbArgs(['fixtures/projects/blink-led.json', '--out', 'x']), io);
    expect(seeded.exitCode).toBe(0);
    expect(seeded.lines.at(-1)).toMatch(/^DRC: \d+ errors?, 1 warning, 3 connections unrouted — 3 footprints, 3 nets$/);
    expect(seeded.lines).toContain('warning courtyard-overlap (106.25, 12.71): D1 and R1 overlap.');
    // The breadboard put the resistor's lead in the LED cathode's row: real footprints touch there.
    expect(seeded.lines).toContain('error short (106.68, 13.28): Copper joins nets GND and Net-(D1-Pad2).');
    expect(runPcb(parsePcbArgs(['fixtures/projects/blink-led.json', '--out', 'x', '--drc']), io).exitCode).toBe(1);
    const zipped = runPcb(parsePcbArgs(['fixtures/projects/blink-led.json', '--out', 'x', '--zip']), io);
    expect(zipped.files.map((f) => f.name)).toEqual(['blink-led-fab.zip']);
  });

  it('refuses bad arguments and bad layouts', () => {
    expect(() => parsePcbArgs(['p.json'])).toThrow(UsageError);
    expect(() => parsePcbArgs(['p.json', '--out', 'x', '--what'])).toThrow(/unknown option/);
    const bad = runPcb(parsePcbArgs(['fixtures/projects/blink-led.json', '--pcb', 'fixtures/projects/blink-led.json', '--out', 'x']), io);
    expect(bad.exitCode).toBe(2);
    expect(bad.lines[0]).toBe('error — fixtures/projects/blink-led.json: /outline must be an array; /footprints must be an array; /traces must be an array; /vias must be an array');
  });

  it('runs under plain node and writes the files', () => {
    const out = mkdtempSync(join(tmpdir(), 'benchtop-pcb-'));
    try {
      const stdout = execFileSync(process.execPath, ['apps/cli/src/main.ts', 'pcb', 'fixtures/projects/blink-led.json', '--pcb', 'fixtures/pcb/blink.pcb.json', '--out', out, '--drc'], { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(stdout).toContain('DRC: 0 errors');
      expect(readdirSync(out).sort()).toContain('blink-F_Cu.gtl');
      expect(readdirSync(join(out, 'Benchtop.pretty')).sort()).toEqual(['LED_D5.0mm.kicad_mod', 'R_Axial_P10.16mm.kicad_mod', 'arduino-uno.kicad_mod']);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
