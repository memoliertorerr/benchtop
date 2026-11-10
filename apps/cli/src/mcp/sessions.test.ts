import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, withheldFirmware } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
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

  it('sim_update (BT79): an LED added to a running blink — no reboot, the watch goes on; a re-flash restarts the board', async () => {
    const server = testServer();
    const { session } = (await tool(server, 'sim_open', { ...blink, watch: ['uno:13'] })).value as { session: string };
    await tool(server, 'sim_run', { session, duration: '1200ms' });
    const doc = JSON.parse(readFileSync(join(REPO_ROOT, blink.project), 'utf8')) as { parts: object[]; wires: object[] };
    const edited = {
      ...doc,
      parts: [...doc.parts, { id: 'ledx', type: 'led', x: 340, y: 200, rotation: 0, props: { color: 'red' } }, { id: 'rx', type: 'resistor', x: 300, y: 200, rotation: 0, props: { ohms: 220 } }],
      wires: [
        ...doc.wires,
        { id: 'wx1', from: { part: 'uno', pin: '13' }, to: { part: 'rx', pin: '1' }, waypoints: [], color: 'green' },
        { id: 'wx2', from: { part: 'rx', pin: '2' }, to: { part: 'ledx', pin: 'A' }, waypoints: [], color: 'green' },
        { id: 'wx3', from: { part: 'ledx', pin: 'C' }, to: { part: 'uno', pin: 'GND.2' }, waypoints: [], color: 'black' },
      ],
    };
    const update = (await tool(server, 'sim_update', { session, projectJson: edited })).value as { now: string; kept: string[]; started: string[]; removed: string[]; unwatched: string[]; parts: { id: string }[] };
    expect(update).toMatchObject({ now: '1200ms', kept: ['uno'], started: [], removed: [], unwatched: [] });
    expect(update.parts.map((p) => p.id)).toContain('ledx');
    const run = (await tool(server, 'sim_run', { session, duration: '1s' })).value as Run;
    expect(run.serial.uno).toBe(''); // no second "hello": the sketch never restarted
    expect(run.watched?.['uno:13']).toMatchObject({ edges: 2 }); // 1.5 s and 2 s, on schedule
    const state = (await tool(server, 'sim_state', { session, parts: ['ledx'] })).value as { now: string; parts: { ledx: { brightness: number } } };
    expect(state.now).toBe('2200ms');
    expect(state.parts.ledx.brightness).toBeGreaterThan(0.5); // on 2 s → 2.5 s
    // Naming the board's firmware re-flashes it: it boots again ("hello").
    const again = (await tool(server, 'sim_update', { session, projectJson: edited, firmware: blink.firmware })).value as { kept: string[]; started: string[] };
    expect(again).toMatchObject({ kept: [], started: ['uno'] });
    expect(((await tool(server, 'sim_run', { session, duration: '100ms' })).value as Run).serial.uno).toBe('hello\r\n');
    expect((await tool(server, 'sim_update', { session, projectJson: { ...edited, parts: [{ id: 'BAD', type: 'led' }] } })).text).toMatch(/invalid project/);
  }, 30_000);

  it('sim_bus (BT88): the I2C LCD\'s writes and the serial text since the last call, filtered and capped', async () => {
    const server = testServer();
    const { session } = (await tool(server, 'sim_open', { project: 'fixtures/projects/lcd-i2c.json', firmware: { uno: 'fixtures/firmware/uno/lcd-i2c.hex' } })).value as { session: string };
    await tool(server, 'sim_run', { session, duration: '200ms' });
    type Tx = { t: string; bus: string; source: string; part?: string; address?: string; read?: boolean; bytes?: string; direction?: string; text?: string; count: number };
    const all = (await tool(server, 'sim_bus', { session, max: 1000 })).value as { transactions: Tx[]; more?: number };
    const i2c = all.transactions.filter((t) => t.bus === 'i2c');
    expect(i2c.length).toBeGreaterThan(20);
    expect(i2c[0]).toMatchObject({ source: 'lcd1 (I2C 0x27)', part: 'lcd1', address: '0x27', read: false, count: 1 });
    expect(all.transactions.filter((t) => t.bus === 'uart').map((t) => t.text).join('')).toContain('nack=2\\r\\n');
    // nothing new without running; then only what the next run made
    expect(((await tool(server, 'sim_bus', { session })).value as { transactions: Tx[] }).transactions).toEqual([]);
    await tool(server, 'sim_run', { session, duration: '100ms' });
    const uart = (await tool(server, 'sim_bus', { session, bus: 'uart' })).value as { transactions: Tx[] };
    expect(uart.transactions.every((t) => t.bus === 'uart')).toBe(true);
    await tool(server, 'sim_run', { session, duration: '900ms' }); // the sketch writes "t=1" at 1 s
    const capped = (await tool(server, 'sim_bus', { session, part: 'lcd1', max: 3 })).value as { transactions: Tx[]; more?: number };
    expect(capped.transactions).toHaveLength(3);
    expect(capped.more).toBeGreaterThan(0);
  }, 30_000);

  it('sim_files (BT91): a card\'s files as the sketch left them; read, write and remove', async () => {
    const server = testServer();
    const { session } = (await tool(server, 'sim_open', { project: 'fixtures/projects/sd-log.json', firmware: { uno: 'fixtures/firmware/uno/sd-log.hex' } })).value as { session: string };
    type Listing = { files: { path: string; size?: number; dir?: boolean; modified: string }[] };
    expect(((await tool(server, 'sim_files', { session, part: 'sd' })).value as Listing).files).toEqual([{ path: 'CONFIG.TXT', size: 8, modified: '2026-01-01 00:00:00' }]);
    await tool(server, 'sim_run', { session, duration: '1s' });
    const listing = (await tool(server, 'sim_files', { session, part: 'sd' })).value as Listing;
    expect(listing.files.map((f) => [f.path, f.size ?? 'dir'])).toEqual([
      ['CONFIG.TXT', 8],
      ['LOG.TXT', 24],
      ['DATA', 'dir'],
      ['DATA/A.CSV', 12],
    ]);
    expect((await tool(server, 'sim_files', { session, part: 'sd', path: 'log.txt' })).value).toMatchObject({ path: 'log.txt', size: 24, text: 'line 0\r\nline 1\r\nline 2\r\n' });
    expect((await tool(server, 'sim_files', { session, part: 'sd', path: 'blob.bin', writeBase64: 'AAEC/w==' })).value).toMatchObject({ wrote: 'blob.bin', size: 4 });
    expect((await tool(server, 'sim_files', { session, part: 'sd', path: 'blob.bin' })).value).toMatchObject({ size: 4, base64: 'AAEC/w==' });
    expect((await tool(server, 'sim_files', { session, part: 'sd', path: 'CONFIG.TXT', write: 'rate=99\n' })).value).toMatchObject({ size: 8 });
    expect((await tool(server, 'sim_files', { session, part: 'sd', path: 'DATA', remove: true })).value).toMatchObject({ removed: 'DATA' });
    expect((await tool(server, 'sim_files', { session, part: 'sd', path: 'DATA/A.CSV' })).text).toMatch(/no file "DATA\/A.CSV"/);
    expect((await tool(server, 'sim_files', { session, part: 'uno' })).text).toMatch(/keeps no files/);
    expect((await tool(server, 'sim_files', { session, part: 'sd', write: 'x' })).text).toMatch(/say which file/);
    // the sketch reads the new config after a reset
    await tool(server, 'sim_reset', { session });
    const again = (await tool(server, 'sim_run', { session, duration: '1s' })).value as Run;
    expect(again.serial.uno).toContain('config: rate=99');
  }, 30_000);

  it('sim_wifi and sim_http (BT100): the ESP32 web server on the access point, asked by its hostname', async () => {
    const server = testServer({ maxWallMs: 120_000 });
    const open = (await tool(server, 'sim_open', { project: 'fixtures/projects/esp32-wifi-webserver.json', firmware: { esp: 'fixtures/firmware/esp32/wifi-webserver.bin' } })).value as { session: string };
    const session = open.session;
    type Wifi = { accessPoints: { part: string; ssid: string; on: boolean; stations: { board: string; ip: string | null; hostname?: string }[]; clients: { part: string; address: string; request: string; sent: number }[] }[]; boards: Record<string, string> };
    expect(((await tool(server, 'sim_wifi', { session })).value as Wifi).boards).toEqual({ esp: 'not connected' });
    await tool(server, 'sim_run', { session, untilSerial: 'server at', duration: '5s' });
    const wifi = (await tool(server, 'sim_wifi', { session })).value as Wifi;
    expect(wifi.boards).toEqual({ esp: 'connected to "benchtop" as 192.168.4.2' });
    expect(wifi.accessPoints[0]).toMatchObject({ part: 'ap', ssid: 'benchtop', on: true, stations: [{ board: 'esp', ip: '192.168.4.2', hostname: 'esp32-web' }] });
    expect(wifi.accessPoints[0].clients.map((c) => [c.part, c.address, c.request, c.sent])).toEqual([
      ['on', '192.168.4.10', 'GET http://esp32-web/led?state=on', 0],
      ['off', '192.168.4.11', 'GET http://esp32-web/led?state=off', 0],
    ]);
    type Http = { status?: number; body?: string; headers?: Record<string, string>; error?: string; ran: string; serial: Record<string, string> };
    const on = (await tool(server, 'sim_http', { session, url: 'http://ESP32-WEB/led?state=on' })).value as Http;
    expect(on).toMatchObject({ status: 200, body: 'led on' });
    expect(on.serial.esp).toContain('GET /led on\n'); // the serial output since the last call
    expect(on.headers?.['content-type']).toBe('text/plain');
    const state = (await tool(server, 'sim_state', { session, parts: ['led1'] })).value as { parts: Record<string, { brightness: number }> };
    expect(state.parts.led1.brightness).toBeGreaterThan(0.3);
    expect((await tool(server, 'sim_http', { session, url: 'http://192.168.4.2/nothing', method: 'POST', body: 'x' })).value).toMatchObject({ status: 404, body: 'not here' });
    expect((await tool(server, 'sim_http', { session, url: 'http://nobody/' })).value).toMatchObject({ error: expect.stringMatching(/^no host "nobody"/) });
    expect((await tool(server, 'sim_http', { session, url: 'http://192.168.4.99/', timeout: '200ms' })).value).toMatchObject({ error: 'no response within 200ms', ran: '200ms' });
    expect((await tool(server, 'sim_http', { session, url: 'https://esp32-web/' })).value).toMatchObject({ error: "https isn't simulated: use http://" });
    expect((await tool(server, 'sim_http', { session, url: 'http://esp32-web/', network: 'elsewhere' })).value).toMatchObject({ error: 'no access point has the SSID "elsewhere"' });
    const blinkSession = ((await tool(server, 'sim_open', blink)).value as { session: string }).session;
    expect((await tool(server, 'sim_http', { session: blinkSession, url: 'http://x/' })).text).toMatch(/no WiFi access point/);
  }, 120_000);

  it('sim_storage (BT119): an ESP32\'s NVS entries and an Uno\'s EEPROM bytes; erase; sim_reset keeps memory unless erase', async () => {
    const server = testServer({ maxWallMs: 120_000 });
    const board = (id: string, type: string) => ({ format: 1, name: id, parts: [{ id, type, x: 0, y: 0, rotation: 0, props: {} }], wires: [], firmware: {} });
    type Storage = { kind: string; size: number; sectorsInUse: string[]; bytes?: Record<string, number>; nvs?: { partition: string; entries: { namespace: string; key: string; type: string; value: string | number; size?: number }[] }[] };
    const esp = ((await tool(server, 'sim_open', { projectJson: board('esp', 'esp32-devkit-v1'), firmware: { esp: 'fixtures/firmware/esp32/prefs-types.bin' } })).value as { session: string }).session;
    await tool(server, 'sim_run', { session: esp, untilSerial: 'written', duration: '5s' });
    const nvs = (await tool(server, 'sim_storage', { session: esp })).value as Storage;
    expect(nvs).toMatchObject({ kind: 'flash', size: 4 * 1024 * 1024 });
    expect(nvs.sectorsInUse).toEqual(['0x9000', '0xa000']);
    const entries = nvs.nvs?.[0].entries ?? [];
    expect(nvs.nvs?.[0].partition).toBe('nvs');
    expect(entries.find((e) => e.key === 'u64')).toEqual({ namespace: 'types', key: 'u64', type: 'u64', value: '18000000000000000000' });
    expect(entries.find((e) => e.key === 'short')).toEqual({ namespace: 'types', key: 'short', type: 'string', value: 'hi' });
    expect(entries.find((e) => e.key === 'big')).toEqual({ namespace: 'types', key: 'big', type: 'blob', size: 5000, value: Array.from({ length: 64 }, (_, i) => i.toString(16).padStart(2, '0')).join('') });
    expect(entries.find((e) => e.key === 'n')).toEqual({ namespace: 'other', key: 'n', type: 'u32', value: 7 });
    // The Uno's boot counter: sim_reset keeps its EEPROM, sim_reset { erase } doesn't.
    const uno = ((await tool(server, 'sim_open', { projectJson: board('uno', 'arduino-uno'), firmware: { uno: 'fixtures/firmware/uno/eeprom-counter.hex' } })).value as { session: string }).session;
    await tool(server, 'sim_run', { session: uno, duration: '200ms' });
    expect(((await tool(server, 'sim_storage', { session: uno })).value as Storage)).toMatchObject({ kind: 'eeprom', size: 1024, sectorsInUse: ['0x0'], bytes: { '0': 1 } });
    await tool(server, 'sim_reset', { session: uno });
    await tool(server, 'sim_run', { session: uno, duration: '200ms' });
    expect(((await tool(server, 'sim_storage', { session: uno })).value as Storage).bytes).toEqual({ '0': 2 });
    await tool(server, 'sim_reset', { session: uno, erase: true });
    await tool(server, 'sim_run', { session: uno, duration: '200ms' });
    expect(((await tool(server, 'sim_storage', { session: uno })).value as Storage).bytes).toEqual({ '0': 1 });
    expect((await tool(server, 'sim_storage', { session: uno, erase: true })).value).toMatchObject({ erased: true });
    expect(((await tool(server, 'sim_storage', { session: uno })).value as Storage)).toMatchObject({ sectorsInUse: [], bytes: {} });
    expect((await tool(server, 'sim_storage', { session: uno, board: 'nope' })).text).toMatch(/no board "nope"/);
  }, 120_000);

  it('sim_state (BT123): a board asleep — deep or light, when the timer wakes it, its wake pins — and awake again', async () => {
    const server = testServer({ maxWallMs: 120_000 });
    const session = ((await tool(server, 'sim_open', { project: 'fixtures/projects/esp32-deep-sleep.json', firmware: { esp: 'fixtures/firmware/esp32/deep-sleep-counter.bin' } })).value as { session: string }).session;
    type State = { sleeping?: Record<string, { sleep: string; timerWakesAt?: string; wakePins: string[] }> };
    await tool(server, 'sim_run', { session, duration: '1s' });
    const asleep = (await tool(server, 'sim_state', { session, parts: [] })).value as State;
    expect(asleep.sleeping?.esp).toMatchObject({ sleep: 'deep', wakePins: ['GPIO4 low'] });
    expect(asleep.sleeping?.esp.timerWakesAt).toMatch(/^5\d{3}ms$/); // 5 s after it went to sleep
    await tool(server, 'sim_input', { session, part: 'btn1', input: { kind: 'press' } });
    await tool(server, 'sim_run', { session, duration: '100ms' });
    expect(((await tool(server, 'sim_state', { session, parts: [] })).value as State).sleeping).toBeUndefined();
  }, 120_000);

  it('sim_wifi (BT117): an ESP32 hosting its own access point — the client parts on it, their addresses from its DHCP server', async () => {
    const server = testServer({ maxWallMs: 120_000 });
    const open = (await tool(server, 'sim_open', { project: 'fixtures/projects/esp32-softap-webserver.json', firmware: { esp: 'fixtures/firmware/esp32/softap-webserver.bin' } })).value as { session: string };
    const session = open.session;
    type Wifi = {
      accessPoints: unknown[];
      softAccessPoints: { board: string; ssid: string; channel: number; security: string; maxStations: number; stations: { part?: string; board?: string; ip: string | null; hostname?: string }[]; clients: { part: string; address: string | null }[] }[];
      waiting?: { part: string; network: string }[];
      boards: Record<string, string>;
    };
    const before = (await tool(server, 'sim_wifi', { session })).value as Wifi;
    expect(before).toMatchObject({ accessPoints: [], softAccessPoints: [], waiting: [{ part: 'on', network: 'esp32-ap' }, { part: 'off', network: 'esp32-ap' }], boards: { esp: 'not connected' } });
    await tool(server, 'sim_run', { session, duration: '1500ms' });
    const wifi = (await tool(server, 'sim_wifi', { session })).value as Wifi;
    expect(wifi.boards).toEqual({ esp: 'hosting "esp32-ap"' });
    expect(wifi.waiting).toBeUndefined();
    expect(wifi.softAccessPoints).toHaveLength(1);
    expect(wifi.softAccessPoints[0]).toMatchObject({ board: 'esp', ssid: 'esp32-ap', channel: 1, security: 'wpa2', maxStations: 4 });
    expect(wifi.softAccessPoints[0].stations.map((st) => [st.part, st.ip, st.hostname])).toEqual([
      ['on', '192.168.4.2', 'on'],
      ['off', '192.168.4.3', 'off'],
    ]);
    expect(wifi.softAccessPoints[0].clients.map((c) => [c.part, c.address])).toEqual([
      ['on', '192.168.4.2'],
      ['off', '192.168.4.3'],
    ]);
  }, 120_000);

  // Skipped where the Pico W firmware is withheld (the published repository; THIRD_PARTY_NOTICES.md).
  it.skipIf(withheldFirmware('picow/wifi-webserver.uf2') !== undefined)('sim_wifi and sim_http (BT112): a Pico W web server, its onboard LED switched over HTTP', async () => {
    const server = testServer({ maxWallMs: 120_000 });
    const open = (await tool(server, 'sim_open', { project: 'fixtures/projects/picow-wifi-webserver.json', firmware: { picow: 'fixtures/firmware/picow/wifi-webserver.uf2' } })).value as { session: string };
    const session = open.session;
    type Wifi = { accessPoints: { stations: { board: string; ip: string | null; hostname?: string; mac: string }[] }[]; boards: Record<string, string> };
    expect(((await tool(server, 'sim_wifi', { session })).value as Wifi).boards).toEqual({ picow: 'not connected' });
    await tool(server, 'sim_run', { session, untilSerial: 'server at', duration: '5s' });
    const wifi = (await tool(server, 'sim_wifi', { session })).value as Wifi;
    expect(wifi.boards).toEqual({ picow: 'connected to "benchtop" as 192.168.4.2' });
    expect(wifi.accessPoints[0].stations[0]).toMatchObject({ board: 'picow', ip: '192.168.4.2', hostname: 'picow-web', mac: expect.stringMatching(/^28:cd:c1:/) });
    expect((await tool(server, 'sim_http', { session, url: 'http://picow-web/led?state=on' })).value).toMatchObject({ status: 200, body: 'led on' });
    const state = (await tool(server, 'sim_state', { session, parts: ['picow'] })).value as { parts: Record<string, { led: number }> };
    expect(state.parts.picow.led).toBeGreaterThan(0.3);
  }, 120_000);

  it('sim_wifi and sim_http (BT108): an ESP32-C3 web server, its RGB LED set over HTTP', async () => {
    const server = testServer({ maxWallMs: 120_000 });
    const open = (await tool(server, 'sim_open', { project: 'fixtures/projects/esp32c3-wifi-rgb-server.json', firmware: { c3: 'fixtures/firmware/esp32c3/wifi-rgb-server.bin' } })).value as { session: string };
    const session = open.session;
    type Wifi = { accessPoints: { stations: { board: string; ip: string | null; hostname?: string; mac: string }[] }[]; boards: Record<string, string> };
    expect(((await tool(server, 'sim_wifi', { session })).value as Wifi).boards).toEqual({ c3: 'not connected' });
    await tool(server, 'sim_run', { session, untilSerial: 'server at', duration: '5s' });
    const wifi = (await tool(server, 'sim_wifi', { session })).value as Wifi;
    expect(wifi.boards).toEqual({ c3: 'connected to "benchtop" as 192.168.4.2' });
    expect(wifi.accessPoints[0].stations[0]).toMatchObject({ board: 'c3', ip: '192.168.4.2', hostname: 'c3-web', mac: expect.stringMatching(/^34:85:18:/) });
    expect((await tool(server, 'sim_http', { session, url: 'http://c3-web/led?color=12ab34' })).value).toMatchObject({ status: 200, body: 'led 12ab34' });
    const state = (await tool(server, 'sim_state', { session, parts: ['c3'] })).value as { parts: Record<string, { pixels: number[] }> };
    expect(state.parts.c3.pixels[0]).toBe(0x12ab34);
    expect((await tool(server, 'sim_http', { session, url: 'http://c3-web/led?color=mauve' })).value).toMatchObject({ status: 400, body: 'bad color' });
  }, 120_000);

  it('BT129: an ESP32-S3 web server on sim_wifi and sim_http, and the S3 asleep in sim_state', async () => {
    const server = testServer({ maxWallMs: 120_000 });
    const open = (await tool(server, 'sim_open', { project: 'fixtures/projects/esp32s3-wifi-rgb-server.json', firmware: { s3: 'fixtures/firmware/esp32s3/wifi-rgb-server.bin' } })).value as { session: string };
    const session = open.session;
    type Wifi = { accessPoints: { stations: { board: string; ip: string | null; hostname?: string; mac: string }[] }[]; boards: Record<string, string> };
    expect(((await tool(server, 'sim_wifi', { session })).value as Wifi).boards).toEqual({ s3: 'not connected' });
    await tool(server, 'sim_run', { session, untilSerial: 'server at', duration: '5s' });
    const wifi = (await tool(server, 'sim_wifi', { session })).value as Wifi;
    expect(wifi.boards).toEqual({ s3: 'connected to "benchtop" as 192.168.4.2' });
    expect(wifi.accessPoints[0].stations[0]).toMatchObject({ board: 's3', ip: '192.168.4.2', hostname: 's3-web', mac: expect.stringMatching(/^34:85:18:/) });
    expect((await tool(server, 'sim_http', { session, url: 'http://s3-web/led?color=12ab34' })).value).toMatchObject({ status: 200, body: 'led 12ab34' });
    const state = (await tool(server, 'sim_state', { session, parts: ['s3'] })).value as { parts: Record<string, { pixels: number[] }> };
    expect(state.parts.s3.pixels[0]).toBe(0x12ab34);
    // The S3's deep sleep.
    const sleeper = ((await tool(server, 'sim_open', { project: 'fixtures/projects/esp32s3-deep-sleep.json', firmware: { s3: 'fixtures/firmware/esp32s3/deep-sleep-counter.bin' } })).value as { session: string }).session;
    type State = { sleeping?: Record<string, { sleep: string; timerWakesAt?: string; wakePins: string[] }> };
    await tool(server, 'sim_run', { session: sleeper, duration: '1s' });
    const asleep = (await tool(server, 'sim_state', { session: sleeper, parts: [] })).value as State;
    expect(asleep.sleeping?.s3).toMatchObject({ sleep: 'deep', wakePins: ['GPIO4 low'] });
    expect(asleep.sleeping?.s3.timerWakesAt).toMatch(/^5\d{3}ms$/);
  }, 120_000);

  it('BT153: an ESP32-S2 web server on sim_wifi and sim_http, and the S2 asleep in sim_state', async () => {
    const server = testServer({ maxWallMs: 120_000 });
    const open = (await tool(server, 'sim_open', { project: 'fixtures/projects/esp32s2-wifi-rgb-server.json', firmware: { s2: 'fixtures/firmware/esp32s2/wifi-rgb-server.bin' } })).value as { session: string };
    const session = open.session;
    type Wifi = { accessPoints: { stations: { board: string; ip: string | null; hostname?: string; mac: string }[] }[]; boards: Record<string, string> };
    expect(((await tool(server, 'sim_wifi', { session })).value as Wifi).boards).toEqual({ s2: 'not connected' });
    await tool(server, 'sim_run', { session, untilSerial: 'server at', duration: '5s' });
    const wifi = (await tool(server, 'sim_wifi', { session })).value as Wifi;
    expect(wifi.boards).toEqual({ s2: 'connected to "benchtop" as 192.168.4.2' });
    expect(wifi.accessPoints[0].stations[0]).toMatchObject({ board: 's2', ip: '192.168.4.2', hostname: 's2-web', mac: expect.stringMatching(/^7c:df:a1:/) });
    expect((await tool(server, 'sim_http', { session, url: 'http://s2-web/led?color=12ab34' })).value).toMatchObject({ status: 200, body: 'led 12ab34' });
    const state = (await tool(server, 'sim_state', { session, parts: ['s2'] })).value as { parts: Record<string, { pixels: number[] }> };
    expect(state.parts.s2.pixels[0]).toBe(0x12ab34);
    // The S2's deep sleep.
    const sleeper = ((await tool(server, 'sim_open', { project: 'fixtures/projects/esp32s2-deep-sleep.json', firmware: { s2: 'fixtures/firmware/esp32s2/deep-sleep-counter.bin' } })).value as { session: string }).session;
    type State = { sleeping?: Record<string, { sleep: string; timerWakesAt?: string; wakePins: string[] }> };
    await tool(server, 'sim_run', { session: sleeper, duration: '1s' });
    const asleep = (await tool(server, 'sim_state', { session: sleeper, parts: [] })).value as State;
    expect(asleep.sleeping?.s2).toMatchObject({ sleep: 'deep', wakePins: ['GPIO4 low'] });
    expect(asleep.sleeping?.s2.timerWakesAt).toMatch(/^5\d{3}ms$/);
  }, 120_000);

  it('BT157: describe_part names the touch pad’s inputs; sim_input touches it on the S2 touch lamp example', async () => {
    const server = testServer({ maxWallMs: 60_000 });
    const pad = (await tool(server, 'describe_part', { type: 'touch-pad' })).value as { pins: { name: string }[]; inputs: { kind: string }[]; props: Record<string, unknown> };
    expect(pad.pins.map((p) => p.name)).toEqual(['PAD']);
    expect(pad.inputs.map((i) => i.kind)).toEqual(['press', 'release', 'value']);
    expect(pad.props).toMatchObject({ padPf: 2, fingerPf: 10, contact: 0 });
    const { session } = (await tool(server, 'open_example', { id: 'esp32s2-touch-lamp' })).value as { session: string };
    await tool(server, 'sim_run', { session, untilSerial: 'touch lamp ready', duration: '2s' });
    await tool(server, 'sim_input', { session, part: 'pad', input: { kind: 'press' } });
    const touched = (await tool(server, 'sim_run', { session, untilSerial: 'lamp on', duration: '1s' })).value as Run;
    expect(touched.serial.s2).toContain('lamp on');
    await tool(server, 'sim_input', { session, part: 'pad', input: { kind: 'release' } });
    await tool(server, 'sim_run', { session, duration: '200ms' });
    const state = (await tool(server, 'sim_state', { session, parts: ['s2', 'pad'] })).value as { parts: Record<string, { pixels?: number[]; contact?: number }> };
    expect(state.parts.s2.pixels?.[0]).toBe(0xffa03c);
    expect(state.parts.pad.contact).toBe(0);
  }, 60_000);

  it('BT183: sim_state reads an OLED as braille lines (uno-sh1106: the circle, a corner pixel)', async () => {
    const server = testServer();
    const { session } = (await tool(server, 'open_example', { id: 'uno-sh1106' })).value as { session: string };
    await tool(server, 'sim_run', { session, untilSerial: 'count 1', duration: '3s' });
    const state = (await tool(server, 'sim_state', { session, parts: ['oled'] })).value as { parts: { oled: { screen: string[]; fb: { length: number } } } };
    const { screen, fb } = state.parts.oled;
    expect(fb.length).toBe(256); // still summarized
    expect(screen).toHaveLength(16);
    expect(screen.every((line) => line.length === 64 && /^[\u2800-\u28ff]+$/.test(line))).toBe(true);
    expect(screen[0].codePointAt(0)! & 0x01).toBe(0x01); // pixel (0, 0)
    expect(screen[8].codePointAt(32)! - 0x2800).toBeGreaterThan(0); // the circle's top at (64, 32)
  }, 60_000);

  it('BT189: sim_state reads a MAX7219 matrix as lines and a 7-segment module as its digits (uno-ledcontrol)', async () => {
    const server = testServer();
    const { session } = (await tool(server, 'open_example', { id: 'uno-ledcontrol' })).value as { session: string };
    await tool(server, 'sim_run', { session, untilSerial: 'drawn', duration: '1s' });
    const state = (await tool(server, 'sim_state', { session, parts: ['seg', 'm'] })).value as { parts: { seg: { shows: string }; m: { screen: string[] } } };
    expect(state.parts.seg.shows).toBe('HELP 123');
    expect(state.parts.m.screen).toEqual(['..####..', '.#....#.', '#.#..#.#', '#......#', '#.#..#.#', '#..##..#', '.#....#.', '..####..']);
  }, 60_000);

  it('BT195: sim_state reads a DS3231 module’s time and a BME280’s weather (uno-ds3231, uno-bme280)', async () => {
    const server = testServer();
    const rtc = (await tool(server, 'open_example', { id: 'uno-ds3231' })).value as { session: string };
    await tool(server, 'sim_run', { session: rtc.session, untilSerial: '12:34:52', duration: '4s' });
    const clock = (await tool(server, 'sim_state', { session: rtc.session, parts: ['rtc'] })).value as { parts: { rtc: { time: string; temperature: number } } };
    expect(clock.parts.rtc.time).toMatch(/^2026-11-10 12:34:5[2-3]$/);
    expect(clock.parts.rtc.temperature).toBe(26.5);
    const env = (await tool(server, 'open_example', { id: 'uno-bme280' })).value as { session: string };
    await tool(server, 'sim_input', { session: env.session, part: 'env', input: { kind: 'key', key: 'set:pressure=980', down: true } });
    const state = (await tool(server, 'sim_state', { session: env.session, parts: ['env'] })).value as { parts: { env: { pressure: number; humidity: number } } };
    expect(state.parts.env).toMatchObject({ pressure: 980, humidity: 48 });
  }, 60_000);

  it('BT161: sim_state shows an ESP32 asleep until its touch pad is touched; sim_input wakes it', async () => {
    const server = testServer({ maxWallMs: 60_000 });
    const { session } = (await tool(server, 'open_example', { id: 'esp32-touch-wake' })).value as { session: string };
    await tool(server, 'sim_run', { session, untilSerial: 'sleeping', duration: '2s' });
    await tool(server, 'sim_run', { session, duration: '200ms' });
    type State = { sleeping?: Record<string, { sleep: string; wakePins: string[] }> };
    const asleep = (await tool(server, 'sim_state', { session, parts: [] })).value as State;
    expect(asleep.sleeping?.esp).toMatchObject({ sleep: 'deep', wakePins: ['touch T3 (GPIO15)'] });
    await tool(server, 'sim_input', { session, part: 'pad', input: { kind: 'press' } });
    const woke = (await tool(server, 'sim_run', { session, untilSerial: 'boot 2', duration: '2s' })).value as Run;
    await tool(server, 'sim_input', { session, part: 'pad', input: { kind: 'release' } });
    expect(woke.serial.esp).toContain('boot 2: touch pad 3');
  }, 60_000);

  it('sim_usb (BT146): MIDI by note and by bytes to the synth, the lock keys to a keyboard; sim_state says what the device takes', async () => {
    const server = testServer({ maxWallMs: 120_000 });
    const synth = ((await tool(server, 'sim_open', { project: 'fixtures/projects/esp32s3-usb-synth.json', firmware: { s3: 'fixtures/firmware/esp32s3/usb-synth.bin' } })).value as { session: string }).session;
    expect((await tool(server, 'sim_usb', { session: synth, note: 'A4' })).text).toMatch(/no USB device on the board's port/);
    await tool(server, 'sim_run', { session: synth, untilSerial: 'usb synth ready', duration: '2s' });
    expect((await tool(server, 'sim_usb', { session: synth, note: 'A4', velocity: 90 })).value).toMatchObject({ board: 's3', sent: '90 45 5A' });
    expect((await tool(server, 'sim_usb', { session: synth, note: '69', off: true })).value).toMatchObject({ sent: '80 45 00' });
    expect((await tool(server, 'sim_usb', { session: synth, note: 'C#5', channel: 2 })).value).toMatchObject({ sent: '91 49 64' });
    expect((await tool(server, 'sim_usb', { session: synth, midi: 'B0 7B 00' })).value).toMatchObject({ sent: 'B0 7B 00' });
    const run = (await tool(server, 'sim_run', { session: synth, duration: '100ms' })).value as Run;
    expect(run.serial.s3).toContain('note on 69 90\nnote off 69\nnote on 73 100\ncc 123 0\n');
    expect((await tool(server, 'sim_usb', { session: synth, note: 'H2' })).text).toMatch(/"H2" isn't a note/);
    expect((await tool(server, 'sim_usb', { session: synth })).text).toMatch(/give one of "note", "midi" or "locks"/);
    expect((await tool(server, 'sim_usb', { session: synth, midi: '90 3C', velocity: 5 })).text).toMatch(/"velocity", "channel" and "off" go with "note"/);
    expect((await tool(server, 'sim_usb', { session: synth, midi: '90 3C' })).text).toMatch(/needs 2 data bytes/);
    expect((await tool(server, 'sim_usb', { session: synth, midi: 'zz' })).text).toMatch(/MIDI bytes in hex/);
    type Usb = { usb: Record<string, { takesMidi: boolean; keyboardLeds: boolean; locks: string[] }> };
    expect(((await tool(server, 'sim_state', { session: synth, parts: [] })).value as Usb).usb.s3).toMatchObject({ takesMidi: true, keyboardLeds: false, locks: [] });
    // A keyboard: the lock keys come back as its LEDs.
    const keys = ((await tool(server, 'sim_open', { project: 'fixtures/projects/esp32s3-usb-keys.json', firmware: { s3: 'fixtures/firmware/esp32s3/usb-locks.bin' } })).value as { session: string }).session;
    await tool(server, 'sim_run', { session: keys, untilSerial: 'usb locks ready', duration: '2s' });
    expect((await tool(server, 'sim_usb', { session: keys, locks: ['caps', 'caps'] })).value).toMatchObject({ board: 's3', locks: ['caps'] });
    expect(((await tool(server, 'sim_run', { session: keys, duration: '100ms' })).value as Run).serial.s3).toContain('leds num 0 caps 1 scroll 0\n');
    expect(((await tool(server, 'sim_state', { session: keys, parts: [] })).value as Usb).usb.s3).toMatchObject({ takesMidi: false, keyboardLeds: true, locks: ['caps'] });
    expect((await tool(server, 'sim_usb', { session: keys, note: 'C4' })).text).toMatch(/has no MIDI port to send to/);
    expect((await tool(server, 'sim_usb', { session: keys, board: 'type', locks: [] })).text).toMatch(/no board "type" in the session/);
  }, 120_000);

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
  // Less those whose firmware is withheld (the published repository; THIRD_PARTY_NOTICES.md): never any here.
  const listed = (JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures/examples.json'), 'utf8')) as { id: string; boards: Record<string, { firmware?: string }> }[]).filter((e) =>
    Object.values(e.boards).every((b) => b.firmware === undefined || withheldFirmware(b.firmware) === undefined),
  );

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
