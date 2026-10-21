import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIntelHex } from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { fqbnOf } from '../../../web/src/editor/fqbn.ts';
import { testServer, tool } from './mcp.test-helper.ts';
import { fqbnOfBoard } from './tools/build.ts';

// BT70: the tools that debug, compile and make PCB files. Compiling runs the real arduino-cli
// with the AVR core (a prerequisite, as for the bridge's tests); its output goes to a temp root.

describe('debugging an AVR board in a session', () => {
  it('debug-demo: a breakpoint on a function, registers, a global by symbol, steps, a line breakpoint', async () => {
    const server = testServer();
    const { session } = (await tool(server, 'sim_open', { project: 'fixtures/projects/debug-demo.json', firmware: { uno: 'fixtures/firmware/uno/debug-demo.elf' } })).value as { session: string };
    const set = (await tool(server, 'debug_breakpoints', { session, set: ['addSlow', 'nope'] })).value as { breakpoints: { function?: string }[]; errors: string[] };
    expect(set.breakpoints).toEqual([expect.objectContaining({ function: 'addSlow' })]);
    expect(set.errors).toEqual(['nope: no symbol "nope"']);
    const hit = (await tool(server, 'sim_run', { session, duration: '1s' })).value as { stoppedBy: string; breakpoint: string; at: { function: string; file: string } };
    expect(hit).toMatchObject({ stoppedBy: 'breakpoint', breakpoint: 'uno', at: { function: 'addSlow', file: 'debug-demo.ino' } });
    const regs = (await tool(server, 'debug_registers', { session })).value as { registers: Record<string, number>; flags: string };
    expect(regs.registers.R24 | (regs.registers.R25 << 8)).toBe(1234); // a = seedA, first call
    expect(regs.flags).toMatch(/^[I·][T·][H·][S·][V·][N·][Z·][C·]$/);
    const seed = (await tool(server, 'debug_memory', { session, symbol: 'seedA' })).value as { space: string; value: number; symbol: { size: number } };
    expect(seed).toMatchObject({ space: 'data', value: 1234, symbol: { size: 2 } });
    const stepped = (await tool(server, 'debug_step', { session, count: 3 })).value as { at: { function: string } };
    expect(stepped.at.function).toMatch(/^addSlow\+0x/);
    // Out of addSlow: clear it, break on the DEBUG_MARK line, continue.
    const line = readFileSync(join(REPO_ROOT, 'fixtures/sketches/uno/debug-demo/debug-demo.ino'), 'utf8').split('\n').findIndex((l) => l.includes('// DEBUG_MARK')) + 1;
    await tool(server, 'debug_breakpoints', { session, clearAll: true, set: [`debug-demo.ino:${line}`] });
    const atLine = (await tool(server, 'sim_run', { session, duration: '1s' })).value as { stoppedBy: string; at: { line: number } };
    expect(atLine).toMatchObject({ stoppedBy: 'breakpoint', at: { line } });
    const counter = (await tool(server, 'debug_memory', { session, symbol: 'counter' })).value as { value: number };
    expect(counter.value).toBe(0); // the first loop, before counter++
    const pico = testServer();
    const { session: picoSession } = (await tool(pico, 'sim_open', { project: 'fixtures/projects/pico-blink.json', firmware: { pico: 'fixtures/firmware/pico/blink.uf2' } })).value as { session: string };
    expect((await tool(pico, 'debug_registers', { session: picoSession })).text).toMatch(/has no debugger here/);
  }, 60_000);
});

describe('compile_sketch', () => {
  it('names the same FQBN per board as the web app', () => {
    for (const def of CATALOG.values()) if (def.board !== undefined) expect(fqbnOfBoard(def.type), def.type).toBe(fqbnOf(def.type));
  });

  it('compiles a sketch folder and an inline sketch into .benchtop/build, with diagnostics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'benchtop-mcp-build-'));
    try {
      cpSync(join(REPO_ROOT, 'fixtures/sketches/uno/blink'), join(root, 'blink'), { recursive: true });
      const server = testServer({}, root);
      const built = (await tool(server, 'compile_sketch', { sketch: 'blink', board: 'arduino-uno' })).value as { ok: boolean; firmware: string; files: string[] };
      expect(built).toMatchObject({ ok: true, firmware: '.benchtop/build/blink/blink.ino.elf' });
      expect(built.files.sort()).toEqual(['.benchtop/build/blink/blink.ino.elf', '.benchtop/build/blink/blink.ino.hex']);
      const committed = parseIntelHex(readFileSync(join(REPO_ROOT, 'fixtures/firmware/uno/blink.hex'), 'utf8'), { maxBytes: 32 * 1024 });
      const fresh = parseIntelHex(readFileSync(join(root, '.benchtop/build/blink/blink.ino.hex'), 'utf8'), { maxBytes: 32 * 1024 });
      expect(Buffer.from(fresh.bytes).equals(Buffer.from(committed.bytes))).toBe(true);

      const broken = (await tool(server, 'compile_sketch', { files: { 'oops.ino': 'void setup() {}\nvoid loop() { nope(); }\n' }, board: 'arduino-uno' })).value as { ok: boolean; diagnostics: { file: string; line: number; severity: string }[]; files: string[] };
      expect(broken.ok).toBe(false);
      expect(broken.diagnostics).toContainEqual(expect.objectContaining({ file: 'oops.ino', line: 2, severity: 'error' }));
      expect(broken.files).toEqual([]);

      expect((await tool(server, 'compile_sketch', { sketch: '../x', board: 'arduino-uno' })).text).toMatch(/outside the root folder/);
      expect((await tool(server, 'compile_sketch', { sketch: 'blink', board: 'led' })).text).toMatch(/"led" is not a board part type/);
      expect((await tool(server, 'compile_sketch', { files: { '../a.ino': '' }, board: 'arduino-uno' })).text).toMatch(/bad file name/);
      expect((await tool(server, 'compile_sketch', { sketch: 'blink', fqbn: 'arduino:avr:leonardo' })).isError).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('PCB tools', () => {
  it('pcb_check reports the routed layout and a seeded one; pcb_export writes under .benchtop/pcb', async () => {
    const root = mkdtempSync(join(tmpdir(), 'benchtop-mcp-pcb-'));
    try {
      cpSync(join(REPO_ROOT, 'fixtures/projects/blink-led.json'), join(root, 'blink-led.json'));
      cpSync(join(REPO_ROOT, 'fixtures/pcb/blink.pcb.json'), join(root, 'blink.pcb.json'));
      const server = testServer({}, root);
      const routed = (await tool(server, 'pcb_check', { project: 'blink-led.json', pcb: 'blink.pcb.json' })).value as { ok: boolean; unrouted: number; footprints: number };
      expect(routed).toMatchObject({ ok: true, unrouted: 0 });
      expect(routed.footprints).toBeGreaterThan(1);
      const seeded = (await tool(server, 'pcb_check', { project: 'blink-led.json' })).value as { unrouted: number };
      expect(seeded.unrouted).toBeGreaterThan(0);
      const out = (await tool(server, 'pcb_export', { project: 'blink-led.json', pcb: 'blink.pcb.json' })).value as { files: string[] };
      expect(out.files.length).toBeGreaterThan(5);
      for (const file of out.files) {
        expect(file.startsWith('.benchtop/pcb/')).toBe(true);
        expect(existsSync(join(root, file))).toBe(true);
      }
      const zip = (await tool(server, 'pcb_export', { project: 'blink-led.json', zip: true })).value as { files: string[] };
      expect(zip.files).toHaveLength(1);
      expect(zip.files[0]).toMatch(/\.zip$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
