import { Bench, type BenchEnv, NS_PER_MS, parseProject, type Problem, SymbolTable } from '@benchtop/core';
import { type Esp32s2Mcu, esp32s2McuFactory } from '@benchtop/esp32s2';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedS2Rom } from '../../../esp32s2/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { netSpecFor } from '../network/specs.ts';

// BT151: an ESP32-S2-DevKitM-1 and a wifi-ap part on a full Bench — the ESP32's WiFi driver at its
// API on the S2's core (the same Xtensa HLE, with the fixture's symbols), the bench's virtual
// network and the firmware's own lwIP. The sketches are the ESP32's (and the C3's soft-AP project),
// built for the S2.

const ROM = loadCachedS2Rom();

function load(firmware: string, options: { project?: string; symbols?: boolean } = {}) {
  const json = JSON.parse(readFixtureText(`fixtures/projects/${options.project ?? 'esp32s2-wifi'}.json`));
  const parsed = parseProject(json);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const s2 = esp32s2McuFactory(ROM);
  const symbols = options.symbols === false ? null : SymbolTable.fromNm(readFixtureText(`fixtures/firmware/esp32s2/${firmware}.syms.tsv`));
  let mcu: Esp32s2Mcu | null = null;
  const problems: Problem[] = [];
  const env: BenchEnv = {
    part: benchEnvParts,
    createMcu: (board, id, report) => {
      const created = s2(board, id, (problem) => {
        problems.push(problem);
        report?.(problem);
      }) as Esp32s2Mcu;
      if (symbols !== null) created.useSymbols(symbols);
      mcu = created;
      return created;
    },
  };
  const bench = new Bench(parsed.doc, env, { netSpecFor });
  bench.attachFirmware('s2', { format: 'esp32-bin', app: readFixture(`fixtures/firmware/esp32s2/${firmware}.bin`), partitions: readFixture(`fixtures/firmware/esp32s2/${firmware}.partitions.bin`) });
  bench.reset();
  const serial: number[] = [];
  bench.onSerial('s2', (bytes) => serial.push(...bytes));
  return { bench, text: () => String.fromCharCode(...serial), mcu: (): Esp32s2Mcu => mcu!, problems };
}

function runTo(bench: Bench, maxMs: number, done: () => boolean): void {
  for (let t = bench.now() / NS_PER_MS + 10; t <= maxMs && !done(); t += 10) bench.runUntil(t * NS_PER_MS);
}

describe('WiFi on the ESP32-S2 (BT151)', () => {
  it('scans the access point, connects and gets 192.168.4.2 from its DHCP server, with the board’s MAC', () => {
    const { bench, text, mcu, problems } = load('wifi-scan');
    runTo(bench, 8000, () => /connected .*\n/.test(text()));
    expect(text()).toContain('benchtop -50 3\nscan done 1\n');
    expect(text()).toContain('connected 192.168.4.2\n');
    expect(mcu().soc.periph.radioAccesses).toBe(0);
    const ap = bench.network?.accessPoints[0];
    expect(ap?.stations.size).toBe(1);
    expect([...(ap?.dhcp.leases.values() ?? [])]).toEqual([0xc0a80402]);
    const mac = mcu().soc.efuse.mac;
    expect(mac.slice(0, 3)).toEqual([0x7c, 0xdf, 0xa1]);
    expect([...ap!.stations.keys()][0]).toBe(mac.map((b) => b.toString(16).padStart(2, '0')).join(':'));
    expect(bench.mcuStopped('s2')).toBeNull();
    expect(problems.filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('HTTPClient GETs and POSTs to the http-server part by name (DNS at the gateway, TCP to the part)', () => {
    const { bench, text } = load('wifi-http-get', { project: 'esp32s2-wifi-http' });
    runTo(bench, 10000, () => /POST .*\n/.test(text()));
    expect(text()).toContain('GET 200 {"hello":"world","count":1}\n');
    expect(text()).toContain('POST 200 ping\n');
    const server = bench.network!.serverHosts[0];
    expect(server.http.log.map((e) => `${e.method} ${e.path} ${e.status}`)).toEqual(['GET /api/hello 200', 'POST /api/echo 200']);
    expect(bench.network!.accessPoints[0].dns.asked).toContain('api.bench');
  });

  it('a web server: the http-client parts switch its LED on IO2 by hostname', () => {
    const { bench, text } = load('wifi-webserver', { project: 'esp32s2-wifi-webserver' });
    runTo(bench, 8000, () => /server at .*\n/.test(text()));
    expect(text()).toContain('server at 192.168.4.2\n');
    const client = (id: string) => bench.collectFrame().parts.find(([part]) => part === id)?.[1];
    bench.input('on', { kind: 'press' });
    runTo(bench, bench.now() / NS_PER_MS + 400, () => false);
    expect(bench.pinState('s2', 'IO2')?.level).toBe(1);
    expect(client('on')).toMatchObject({ status: '200' });
    expect(text()).toContain('GET /led on\n');
    bench.input('off', { kind: 'press' });
    runTo(bench, bench.now() / NS_PER_MS + 400, () => false);
    expect(bench.pinState('s2', 'IO2')?.level).toBe(0);
  });

  it('the DevKitM-1\'s RGB LED set over HTTP: wifi-rgb-server as "s2-web"', () => {
    const { bench, text } = load('wifi-rgb-server', { project: 'esp32s2-wifi-rgb-server' });
    runTo(bench, 8000, () => /server at .*\n/.test(text()));
    expect(text()).toContain('server at 192.168.4.2\n');
    const pixel = (): number => ((bench.collectFrame().parts.find(([id]) => id === 's2')?.[1].pixels as number[] | undefined) ?? [-1])[0];
    for (const [client, color] of [['green', 0x00ff00], ['red', 0xff0000], ['off', 0]] as const) {
      bench.input(client, { kind: 'press' });
      runTo(bench, bench.now() / NS_PER_MS + 400, () => false);
      expect(pixel(), client).toBe(color);
      expect(text()).toContain(`led ${client}\n`);
    }
  });

  it('the S2 hosts an access point too (the same driver): client parts take addresses from its DHCP server and get its pages', () => {
    const { bench, text, mcu } = load('wifi-softap', { project: 'esp32s2-softap' });
    runTo(bench, 4000, () => text().split('\n').filter((l) => l.startsWith('assigned ')).length === 2);
    expect(text()).toMatch(/ap at 192\.168\.4\.1 7C:DF:A1(:[0-9A-F]{2}){3}\n/);
    expect(bench.network?.softAccessPoints[0].config).toMatchObject({ ssid: 'benchtop-ap', security: 'wpa2', channel: 6 });
    expect(text().split('\n').filter((l) => l.startsWith('assigned ')).sort()).toEqual(['assigned 192.168.4.2', 'assigned 192.168.4.3']);
    bench.input('count', { kind: 'press' });
    runTo(bench, bench.now() / NS_PER_MS + 500, () => false);
    const visual = bench.collectFrame().parts.find(([id]) => id === 'count')?.[1];
    expect(visual).toMatchObject({ status: '200', body: '2' });
    expect(mcu().soc.periph.radioAccesses).toBe(0);
  });

  it('without symbols the closed driver touches the radio: esp32s2-wifi-no-symbols, once', () => {
    const { bench, problems } = load('wifi-scan', { symbols: false });
    runTo(bench, 1500, () => problems.some((p) => p.code === 'esp32s2-wifi-no-symbols'));
    const reported = problems.filter((p) => p.code === 'esp32s2-wifi-no-symbols');
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toContain('needs the firmware');
  });
});
