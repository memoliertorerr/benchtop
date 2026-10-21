import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { request, testServer, tool } from './mcp.test-helper.ts';

// BT69: live sessions and the examples through the MCP server — the Uno blink measured on a
// watched pin, a button pressed mid-run, serial typed and echoed, inline MicroPython, the limits.

type Run = { now: string; ran: string; stoppedBy: string; serial: Record<string, string>; watched?: Record<string, { edges: number; frequencyHz?: number; dutyPct: number; level: string }>; problems: unknown[] };

const blink = { project: 'fixtures/projects/blink-led.json', firmware: { uno: 'fixtures/firmware/uno/blink.hex' } };

describe('live sessions', () => {
  it('blink: a watched pin\'s frequency and duty per run, serial since the last call, part and pin state', async () => {
    const server = testServer();
    const open = (await tool(server, 'sim_open', { ...blink, watch: ['uno:13'] })).value as { session: string; boards: string[]; now: string };
    expect(open).toMatchObject({ session: 's1', boards: ['uno'], now: '0s' });
    const first = (await tool(server, 'sim_run', { session: 's1', duration: '2s' })).value as Run;
    expect(first).toMatchObject({ now: '2s', ran: '2s', stoppedBy: 'duration', serial: { uno: 'hello\r\n' } });
    expect(first.watched?.['uno:13'].frequencyHz).toBeCloseTo(1, 2);
    expect(first.watched?.['uno:13'].dutyPct).toBeCloseTo(50, 0);
    const second = (await tool(server, 'sim_run', { session: 's1', duration: '250ms' })).value as Run;
    expect(second.serial.uno).toBe('');
    // 2 s → 2.25 s: the LED turns on a hair after 2 s (the loop's toggle lands just past each second)
    expect(second.watched?.['uno:13']).toMatchObject({ edges: 1, level: '1' });
    expect(second.watched?.['uno:13'].dutyPct).toBeGreaterThan(99.5);
    const state = (await tool(server, 'sim_state', { session: 's1', parts: ['led1'], pins: ['uno:13', 'uno:GND.1'] })).value as { now: string; parts: Record<string, { brightness: number }>; pins: Record<string, { level: string; volts: number }> };
    expect(state.now).toBe('2250ms');
    expect(state.parts.led1.brightness).toBeGreaterThan(0.5);
    expect(state.pins['uno:13'].level).toBe('1');
    expect(state.pins['uno:13'].volts).toBeGreaterThan(4.5); // sags a little under the LED's current
    expect(state.pins['uno:13'].volts).toBeLessThanOrEqual(5);
    expect(state.pins['uno:GND.1'].level).toBe('0');
    expect((await tool(server, 'sim_state', { session: 's1', pins: ['uno:99'] })).text).toMatch(/no pin "uno:99"/);
    await tool(server, 'sim_reset', { session: 's1' });
    expect(((await tool(server, 'sim_list')).value as { sessions: { now: string }[] }).sessions[0].now).toBe('0s');
    expect((await tool(server, 'sim_close', { session: 's1' })).value).toEqual({ closed: 's1' });
    expect((await tool(server, 'sim_run', { session: 's1' })).text).toMatch(/no open session "s1"/);
  }, 30_000);

  it('button: an input mid-run lights the LED; inputs are checked like a spec\'s steps', async () => {
    const server = testServer();
    const { session } = (await tool(server, 'sim_open', { project: 'fixtures/projects/button-pullup.json', firmware: { uno: 'fixtures/firmware/uno/button-pullup.hex' } })).value as { session: string };
    await tool(server, 'sim_run', { session, duration: '300ms' });
    const lit = async (): Promise<boolean> => (((await tool(server, 'sim_state', { session, parts: ['led1'] })).value as { parts: { led1: { brightness: number } } }).parts.led1.brightness > 0.5);
    expect(await lit()).toBe(false);
    await tool(server, 'sim_input', { session, part: 'btn1', input: { kind: 'press' } });
    await tool(server, 'sim_run', { session, duration: '100ms' });
    expect(await lit()).toBe(true);
    await tool(server, 'sim_input', { session, part: 'btn1', input: { kind: 'release' } });
    await tool(server, 'sim_run', { session, duration: '100ms' });
    expect(await lit()).toBe(false);
    expect((await tool(server, 'sim_input', { session, part: 'nope', input: { kind: 'press' } })).text).toMatch(/no part "nope"/);
    expect((await tool(server, 'sim_input', { session, part: 'btn1', input: { kind: 'value' } })).text).toMatch(/needs a finite number "value"/);
    expect((await tool(server, 'sim_input', { session, part: 'btn1' })).text).toMatch(/exactly one of "input" or "set"/);
  }, 30_000);

  it('serial: typed text comes back, and a run stops when a text appears', async () => {
    const server = testServer();
    const spec = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures/specs/serial-echo.bench.json'), 'utf8')) as { project: string; firmware: { uno: string } };
    const fromSpecs = (p: string): string => join('fixtures/specs', p);
    const { session } = (await tool(server, 'sim_open', { project: fromSpecs(spec.project), firmware: { uno: fromSpecs(spec.firmware.uno) } })).value as { session: string };
    await tool(server, 'sim_run', { session, duration: '500ms' });
    await tool(server, 'sim_serial', { session, text: 'ping\n' });
    const run = (await tool(server, 'sim_run', { session, duration: '5s', untilSerial: 'ping' })).value as Run;
    expect(run.stoppedBy).toBe('serial');
    expect(run.serial.uno).toContain('ping');
    expect(Number.parseInt(run.ran, 10)).toBeLessThan(1000);
  }, 30_000);

  it('runs inline MicroPython on a Pico', async () => {
    const server = testServer();
    const { session } = (await tool(server, 'sim_open', { project: 'fixtures/projects/pico-blink.json', micropython: { pico: { files: { 'main.py': 'import time\nfor i in range(3):\n    print("tick", i)\n    time.sleep_ms(100)\n' } } } })).value as { session: string };
    const run = (await tool(server, 'sim_run', { session, duration: '2s', untilSerial: 'tick 2' })).value as Run;
    expect(run.stoppedBy).toBe('serial');
    expect(run.serial.pico).toMatch(/^tick 0\r\ntick 1\r\ntick 2/);
  }, 30_000);

  it('limits: the session count, the duration and the wall-clock budget', async () => {
    const server = testServer({ maxSessions: 2, maxSimNs: 5e9 });
    await tool(server, 'sim_open', blink);
    await tool(server, 'sim_open', blink);
    await tool(server, 'sim_run', { session: 's1', duration: '1ms' }); // s2 is now the one used longest ago
    const third = (await tool(server, 'sim_open', blink)).value as { session: string; closed: string };
    expect(third.session).toBe('s3');
    expect(third.closed).toMatch(/^s2 /);
    expect((await tool(server, 'sim_run', { session: 's1', duration: '6s' })).text).toMatch(/over the limit of 5s/);
    const tight = testServer({ maxWallMs: 1 });
    await tool(tight, 'sim_open', blink);
    const run = (await tool(tight, 'sim_run', { session: 's1', duration: '5s' })).value as Run;
    expect(run.stoppedBy).toBe('wall');
    expect(run.now).not.toBe('5s');
  }, 30_000);
});

describe('examples', () => {
  const listed = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures/examples.json'), 'utf8')) as { id: string }[];

  it('list_examples is the gallery\'s list; open_example runs one with its sketch', async () => {
    const server = testServer();
    const all = (await tool(server, 'list_examples')).value as { count: number; categories: string[] };
    expect(all.count).toBe(listed.length);
    expect(all.categories).toContain('Raspberry Pi Pico 2');
    const pico2 = (await tool(server, 'list_examples', { category: 'Raspberry Pi Pico 2', query: 'micropython' })).value as { examples: { id: string; boards: Record<string, string> }[] };
    expect(pico2.examples).toEqual([expect.objectContaining({ id: 'pico2-micropython-blink', boards: { pico: 'MicroPython (blink)' } })]);
    const opened = (await tool(server, 'open_example', { id: 'blink', watch: ['uno:13'] })).value as { session: string; sketches: { uno: Record<string, string> } };
    expect(Object.keys(opened.sketches.uno)).toEqual(['blink.ino']);
    const run = (await tool(server, 'sim_run', { session: opened.session, duration: '2s' })).value as Run;
    expect(run.watched?.['uno:13'].frequencyHz).toBeCloseTo(1, 2);
    expect((await tool(server, 'open_example', { id: '../../etc' })).text).toMatch(/no example "\.\.\/\.\.\/etc"/);
  }, 30_000);

  it('serves each example as a resource', async () => {
    const server = testServer();
    const list = (await request(server, 'resources/list')).result as { resources: { uri: string; mimeType: string }[] };
    expect(list.resources.length).toBe(listed.length);
    expect(list.resources[0]).toMatchObject({ uri: 'benchtop://examples/blink', mimeType: 'application/json' });
    expect(((await request(server, 'resources/templates/list')).result as { resourceTemplates: { uriTemplate: string }[] }).resourceTemplates[0].uriTemplate).toBe('benchtop://examples/{id}');
    const read = (await request(server, 'resources/read', { uri: 'benchtop://examples/pico-micropython-blink' })).result as { contents: { text: string }[] };
    const body = JSON.parse(read.contents[0].text) as { project: { parts: unknown[] }; sketches: { pico: Record<string, string> } };
    expect(body.project.parts.length).toBeGreaterThan(0);
    expect(body.sketches.pico['main.py']).toMatch(/Pin/);
    expect((await request(server, 'resources/read', { uri: 'benchtop://examples/nope' })).error?.code).toBe(-32002);
  });
});
