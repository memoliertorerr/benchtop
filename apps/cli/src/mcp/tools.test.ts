import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { testServer, tool } from './mcp.test-helper.ts';
import { timeText } from './tools/context.ts';

// BT68: the one-shot MCP tools on the repository's fixtures, through the server (arguments
// checked, results as the client sees them).

const blink = { project: 'fixtures/projects/blink-led.json', firmware: { uno: 'fixtures/firmware/uno/blink.hex' } };

describe('catalog tools', () => {
  it('list_parts finds parts by text and category', async () => {
    const server = testServer();
    const all = (await tool(server, 'list_parts')).value as { count: number; parts: { type: string; mcu?: string; takesInput?: boolean }[] };
    expect(all.count).toBeGreaterThan(60);
    expect(all.parts.find((p) => p.type === 'raspberry-pi-pico-2')).toMatchObject({ mcu: 'rp2350' });
    expect(all.parts.find((p) => p.type === 'pushbutton')?.takesInput).toBe(true);
    const sensors = (await tool(server, 'list_parts', { category: 'sensors', query: 'TEMP' })).value as { parts: { type: string }[] };
    expect(sensors.parts.map((p) => p.type)).toContain('ntc-temperature-sensor');
    expect((await tool(server, 'list_parts', { category: 'nope' })).isError).toBe(true);
  });

  it('describe_part gives pins, props, the board map and inputs; breadboards summarized', async () => {
    const server = testServer();
    const uno = (await tool(server, 'describe_part', { type: 'arduino-uno' })).value as { pins: { name: string; role: string; volts?: number }[]; board: { mcu: string; pinMap: Record<string, string> } };
    expect(uno.board.mcu).toBe('atmega328p');
    expect(uno.board.pinMap['13']).toBe('PB5');
    expect(uno.pins.find((p) => p.name === '5V')).toMatchObject({ role: 'power', volts: 5 });
    const pot = (await tool(server, 'describe_part', { type: 'potentiometer' })).value as { inputs: { kind: string; unit: string }[] };
    expect(pot.inputs).toEqual([{ kind: 'value', does: expect.stringMatching(/wiper/), unit: 'fraction', min: 0, max: 1 }]);
    const led = (await tool(server, 'describe_part', { type: 'led' })).value as { props: Record<string, unknown>; inputs: unknown[] };
    expect(led.props.color).toBeDefined();
    expect(led.inputs).toEqual([]);
    const board = (await tool(server, 'describe_part', { type: 'breadboard-half' })).value as { pins: { count: number; note: string } };
    expect(board.pins.count).toBeGreaterThan(120);
    expect((await tool(server, 'describe_part', { type: 'flux-capacitor' })).text).toMatch(/no part type "flux-capacitor"/);
  });
});

describe('validate_project', () => {
  it('lists schema errors with their paths, and the circuit check\'s problems', async () => {
    const server = testServer();
    const broken = (await tool(server, 'validate_project', { projectJson: { format: 1, name: 'x', parts: [{ id: 'U', type: 'arduino-uno' }], wires: [], firmware: {} } })).value as { ok: boolean; errors: { path: string }[] };
    expect(broken.ok).toBe(false);
    expect(broken.errors.map((e) => e.path)).toContain('/parts/0/id');
    const good = (await tool(server, 'validate_project', { project: 'fixtures/projects/blink-led.json' })).value as { ok: boolean; boards: string[]; problems: unknown[] };
    expect(good).toMatchObject({ ok: true, boards: ['uno'], problems: [] });
    const demo = (await tool(server, 'validate_project', { project: 'fixtures/projects/problems-demo.json' })).value as { problems: { code: string }[] };
    expect(demo.problems.map((p) => p.code).sort()).toEqual(['unpowered-part', 'unwired-part']);
    expect((await tool(server, 'validate_project', {})).text).toMatch(/exactly one of "project"/);
    expect((await tool(server, 'validate_project', { project: '../outside.json' })).text).toMatch(/outside the root folder/);
  });
});

describe('run_simulation', () => {
  it('runs a project with firmware and assertions: the report, red assertions as ok: false', async () => {
    const server = testServer();
    const run = (await tool(server, 'run_simulation', { ...blink, expect: ['pin uno:13 frequency is 1 Hz ±1% between 500ms and 2500ms', 'serial contains "hello" by 100ms'] })).value as {
      ok: boolean;
      simulated: string;
      assertions: { ok: boolean }[];
      serial: Record<string, string>;
    };
    expect(run).toMatchObject({ ok: true, simulated: '2500ms', serial: { uno: 'hello\r\n' } });
    expect(run.assertions.every((a) => a.ok)).toBe(true);
    const red = (await tool(server, 'run_simulation', { ...blink, expect: ['pin uno:13 is 0 at 250ms'] })).value as { ok: boolean; assertions: { detail: string }[] };
    expect(red.ok).toBe(false);
    expect(red.assertions[0].detail).toBe('level 1');
  });

  it('takes the project inline and timed steps', async () => {
    const server = testServer();
    const projectJson = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures/projects/button-pullup.json'), 'utf8')) as unknown;
    const run = (await tool(server, 'run_simulation', {
      projectJson,
      firmware: { uno: 'fixtures/firmware/uno/button-pullup.hex' },
      steps: [
        { at: '500ms', part: 'btn1', input: { kind: 'press' } },
        { at: '800ms', part: 'btn1', input: { kind: 'release' } },
      ],
      expect: ['led led1 is dark at 450ms', 'led led1 is lit at 700ms', 'led led1 is dark at 1s'],
    })).value as { ok: boolean };
    expect(run.ok).toBe(true);
  });

  it('runs inline MicroPython on a Pico', async () => {
    const server = testServer();
    const run = (await tool(server, 'run_simulation', {
      project: 'fixtures/projects/pico-blink.json',
      micropython: { pico: { files: { 'main.py': 'from machine import Pin\nimport time\nled = Pin("LED", Pin.OUT)\nled.on()\nprint("on", 6 * 7)\n' } } },
      expect: ['serial contains "on 42" by 1s', 'pin pico:TP5 is 1 at 1s'],
    })).value as { ok: boolean; serial: { pico: string } };
    expect(run.ok).toBe(true);
    expect(run.serial.pico.startsWith('on 42\r\n')).toBe(true);
    const wrong = await tool(server, 'run_simulation', { ...blink, micropython: { uno: { files: { 'main.py': 'print(1)' } } }, duration: '1s' });
    expect(wrong.text).toMatch(/MicroPython runs on the Raspberry Pi Pico and Pico 2/);
  }, 30_000);

  it('refuses runs past the limits, and reports what could not start', async () => {
    const limited = testServer({ maxSimNs: 1e9 });
    expect((await tool(limited, 'run_simulation', { ...blink, duration: '2s' })).text).toBe('the run is 2 s long; the limit is 1 s');
    const tight = testServer({ maxWallMs: 1 });
    expect((await tool(tight, 'run_simulation', { ...blink, duration: '1s' })).text).toMatch(/used up its 1 ms wall-clock budget/);
    const server = testServer();
    expect((await tool(server, 'run_simulation', { project: blink.project, firmware: { uno: 'nope.hex' }, duration: '1s' })).text).toMatch(/cannot read firmware nope\.hex/);
    expect((await tool(server, 'run_simulation', { ...blink, duration: 'soon' })).isError).toBe(true);
    expect((await tool(server, 'run_simulation', { ...blink, firmware: { uno: '/etc/hosts' }, duration: '1s' })).text).toMatch(/outside the root folder/);
  });

  it('cuts serial output at the limit and says so', async () => {
    const server = testServer({ serialChars: 3 });
    const run = (await tool(server, 'run_simulation', { ...blink, duration: '200ms' })).value as { serial: { uno: string }; serialTruncated: string[] };
    expect(run.serial.uno).toBe('hel');
    expect(run.serialTruncated).toEqual(['uno']);
  });
});

describe('run_tests', () => {
  it('runs specs from files and folders and totals them', async () => {
    const server = testServer();
    const result = (await tool(server, 'run_tests', { paths: ['fixtures/specs/blink.bench.json', 'fixtures/specs/button.bench.json'] })).value as { ok: boolean; passed: number; specs: { assertions: string }[] };
    expect(result).toMatchObject({ ok: true, passed: 2, failed: 0, errors: 0 });
    expect(result.specs.map((s) => s.assertions)).toEqual(['6/6', '3/3']);
    expect((await tool(server, 'run_tests', { paths: ['README.md'] })).text).toMatch(/not a folder or a \*\.bench\.json spec/);
    expect((await tool(server, 'run_tests', { paths: ['..'] })).text).toMatch(/outside the root folder/);
    const tight = testServer({ maxWallMs: 1 });
    const cut = (await tool(tight, 'run_tests', { paths: ['fixtures/specs/blink.bench.json', 'fixtures/specs/button.bench.json'] })).value as { ok: boolean; notRun?: string[]; errors: number };
    expect(cut.ok).toBe(false);
    expect(cut.errors + (cut.notRun?.length ?? 0)).toBe(2);
  }, 30_000);
});

describe('timeText', () => {
  it('writes times the CLI grammar reads', () => {
    expect([timeText(2.5e9), timeText(3e9), timeText(250e3), timeText(7)]).toEqual(['2500ms', '3s', '250us', '7ns']);
  });
});
