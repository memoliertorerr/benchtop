import { Bench, type BenchEnv, NS_PER_MS, parseProject, SymbolTable } from '@benchtop/core';
import { type Esp32Mcu, esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { netSpecFor } from '../network/specs.ts';

// BT98: an ESP32 and a wifi-ap part on a full Bench — the bench's virtual network, the ESP32's
// WiFi driver at its API (with the fixture's symbols), and the firmware's own lwIP.

const ROM = loadCachedRom();

function load(firmware: string, props: Record<string, string | number | boolean> = {}, project = 'esp32-wifi') {
  const json = JSON.parse(readFixtureText(`fixtures/projects/${project}.json`));
  json.parts[1].props = props;
  const parsed = parseProject(json);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const esp32 = esp32McuFactory(ROM);
  const symbols = SymbolTable.fromNm(readFixtureText(`fixtures/firmware/esp32/${firmware}.syms.tsv`));
  let mcu: Esp32Mcu | null = null;
  const env: BenchEnv = {
    part: benchEnvParts,
    createMcu: (board, id, report) => {
      const created = esp32(board, id, report) as Esp32Mcu;
      created.useSymbols(symbols);
      mcu = created;
      return created;
    },
  };
  const bench = new Bench(parsed.doc, env, { netSpecFor });
  bench.attachFirmware('esp', { format: 'esp32-bin', app: readFixture(`fixtures/firmware/esp32/${firmware}.bin`), partitions: readFixture(`fixtures/firmware/esp32/${firmware}.partitions.bin`) });
  bench.reset();
  const serial: number[] = [];
  bench.onSerial('esp', (bytes) => serial.push(...bytes));
  return { bench, text: () => String.fromCharCode(...serial), mcu: (): Esp32Mcu => mcu! };
}

function runTo(bench: Bench, maxMs: number, done: () => boolean): void {
  for (let t = bench.now() / NS_PER_MS + 10; t <= maxMs && !done(); t += 10) bench.runUntil(t * NS_PER_MS);
}

/** "status <n> at <ms>" lines of the wifi-connect sketch, as [status, ms]. */
function statuses(text: string): [number, number][] {
  return [...text.matchAll(/status (\d+) at (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

function send(bench: Bench, line: string): void {
  bench.sendSerial('esp', Uint8Array.from([...`${line}\n`].map((c) => c.charCodeAt(0))));
}

describe('WiFi station on the bench (BT98)', () => {
  it('scans the access point, connects and gets 192.168.4.2 from its DHCP server', () => {
    const { bench, text, mcu } = load('wifi-scan');
    runTo(bench, 8000, () => /connected .*\n/.test(text()));
    expect(text()).toContain('benchtop -50 3\nscan done 1\n');
    expect(text()).toContain('connected 192.168.4.2\n');
    expect(mcu().soc.periph.radioAccesses).toBe(0);
    const ap = bench.network?.accessPoints[0];
    expect(ap?.stations.size).toBe(1);
    expect([...(ap?.dhcp.leases.values() ?? [])]).toEqual([0xc0a80402]);
  });

  it('pings the gateway from the firmware’s own lwIP: four echo replies', () => {
    const { bench, text } = load('wifi-ping');
    runTo(bench, 10000, () => text().includes('ping done'));
    expect(text()).toContain('connected 192.168.4.2 gateway 192.168.4.1\n');
    expect(text().match(/reply seq=\d+/g)).toEqual(['reply seq=1', 'reply seq=2', 'reply seq=3', 'reply seq=4']);
    expect(text()).toContain('ping done 4/4\n');
    expect(bench.network?.accessPoints[0].gateway.echoes).toBe(4);
  });

  it('a wrong password: IDF 4.4’s reason 15 (4-way handshake timeout), Arduino keeps retrying, never connected', () => {
    const { bench, text, mcu } = load('wifi-connect');
    runTo(bench, 3000, () => text().includes('ready'));
    send(bench, 'join benchtop wrong-password');
    runTo(bench, 15000, () => false);
    expect(statuses(text()).map(([s]) => s)).not.toContain(3);
    expect(mcu().wifi?.lastReason).toBe(15);
    expect(statuses(text()).at(-1)?.[0]).toBe(6); // WL_DISCONNECTED
  });

  it('an SSID nobody has: NO_AP_FOUND → WL_NO_SSID_AVAIL', () => {
    const { bench, text, mcu } = load('wifi-connect');
    runTo(bench, 3000, () => text().includes('ready'));
    send(bench, 'join nosuchnet simulated');
    runTo(bench, 8000, () => statuses(text()).some(([s]) => s === 1));
    expect(statuses(text()).map(([s]) => s)).toContain(1);
    expect(mcu().wifi?.lastReason).toBe(201);
  });

  it('connects, then WiFi.disconnect() leaves the AP (ASSOC_LEAVE, no reconnect)', () => {
    const { bench, text, mcu } = load('wifi-connect');
    runTo(bench, 3000, () => text().includes('ready'));
    send(bench, 'join benchtop simulated');
    runTo(bench, 8000, () => text().includes('ip '));
    expect(text()).toContain('ip 192.168.4.2\n');
    const ap = bench.network!.accessPoints[0];
    expect(ap.stations.size).toBe(1);
    send(bench, 'leave');
    runTo(bench, bench.now() / NS_PER_MS + 2000, () => false);
    expect(statuses(text()).at(-1)?.[0]).toBe(6);
    expect(mcu().wifi?.lastReason).toBe(8);
    expect(ap.stations.size).toBe(0);
  });

  it('an AP switched off: the station loses it after 6 s (WL_CONNECTION_LOST), then finds no SSID', () => {
    const { bench, text } = load('wifi-connect');
    runTo(bench, 3000, () => text().includes('ready'));
    send(bench, 'join benchtop simulated');
    runTo(bench, 8000, () => text().includes('ip '));
    const off = bench.now() / NS_PER_MS;
    bench.input('ap', { kind: 'key', key: 'set:on=0', down: true });
    runTo(bench, off + 12000, () => statuses(text()).some(([s]) => s === 1));
    const after = statuses(text()).filter(([, ms]) => ms > off);
    expect(after[0][0]).toBe(5); // BEACON_TIMEOUT → WL_CONNECTION_LOST
    expect(after[0][1] - off).toBeGreaterThan(5900);
    expect(after.map(([s]) => s)).toContain(1);
  });

  it('an open AP isn’t joined with a password (Arduino asks for WPA2 then), and is without one', () => {
    const { bench, text, mcu } = load('wifi-connect', { security: 'open' });
    runTo(bench, 3000, () => text().includes('ready'));
    send(bench, 'join benchtop simulated');
    runTo(bench, 8000, () => statuses(text()).some(([s]) => s === 1));
    expect(mcu().wifi?.lastReason).toBe(201);
    send(bench, 'join benchtop');
    runTo(bench, bench.now() / NS_PER_MS + 8000, () => text().includes('ip '));
    expect(text()).toContain('ip 192.168.4.2\n');
  });

  it('BT99: HTTPClient GETs and POSTs to the http-server part by name (DNS at the gateway, TCP to the part)', () => {
    const { bench, text } = load('wifi-http-get', {}, 'esp32-wifi-http');
    runTo(bench, 10000, () => /POST .*\n/.test(text()));
    expect(text()).toContain('GET 200 {"hello":"world","count":1}\n');
    expect(text()).toContain('POST 200 ping\n');
    const server = bench.network!.serverHosts[0];
    expect(server.http.log.map((e) => `${e.method} ${e.path} ${e.status}`)).toEqual(['GET /api/hello 200', 'POST /api/echo 200']);
    expect(bench.network!.accessPoints[0].dns.asked).toContain('api.bench');
    expect(server.host.connections).toBe(0);
  });
});

