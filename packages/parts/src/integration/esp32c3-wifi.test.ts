import { Bench, type BenchEnv, NS_PER_MS, parseProject, type Problem, SymbolTable } from '@benchtop/core';
import { type Esp32c3Mcu, esp32c3McuFactory } from '@benchtop/esp32c3';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedC3Rom } from '../../../esp32c3/src/test-support/rom.test-helper.ts';
import { AP_STA_EVENT, STA_INFO, STA_LIST_C3 } from '../../../esp32/src/wifi/types.ts';
import { benchEnvParts } from '../catalog.ts';
import { netSpecFor } from '../network/specs.ts';

// BT107: an ESP32-C3-DevKitM-1 and a wifi-ap part on a full Bench — the ESP32's WiFi driver at
// its API on the C3 (through @benchtop/riscv's HLE, with the fixture's symbols), the bench's
// virtual network and the firmware's own lwIP. The sketches are the ESP32's, built for the C3.

const ROM = loadCachedC3Rom();

function load(firmware: string, options: { project?: string; symbols?: boolean } = {}) {
  const json = JSON.parse(readFixtureText(`fixtures/projects/${options.project ?? 'esp32c3-wifi'}.json`));
  const parsed = parseProject(json);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const c3 = esp32c3McuFactory(ROM);
  const symbols = options.symbols === false ? null : SymbolTable.fromNm(readFixtureText(`fixtures/firmware/esp32c3/${firmware}.syms.tsv`));
  let mcu: Esp32c3Mcu | null = null;
  const problems: Problem[] = [];
  const env: BenchEnv = {
    part: benchEnvParts,
    createMcu: (board, id, report) => {
      const created = c3(board, id, (problem) => {
        problems.push(problem);
        report?.(problem);
      }) as Esp32c3Mcu;
      if (symbols !== null) created.useSymbols(symbols);
      mcu = created;
      return created;
    },
  };
  const bench = new Bench(parsed.doc, env, { netSpecFor });
  bench.attachFirmware('c3', { format: 'esp32-bin', app: readFixture(`fixtures/firmware/esp32c3/${firmware}.bin`), partitions: readFixture(`fixtures/firmware/esp32c3/${firmware}.partitions.bin`) });
  bench.reset();
  const serial: number[] = [];
  bench.onSerial('c3', (bytes) => serial.push(...bytes));
  return { bench, text: () => String.fromCharCode(...serial), mcu: (): Esp32c3Mcu => mcu!, problems };
}

function runTo(bench: Bench, maxMs: number, done: () => boolean): void {
  for (let t = bench.now() / NS_PER_MS + 10; t <= maxMs && !done(); t += 10) bench.runUntil(t * NS_PER_MS);
}

describe('WiFi on the ESP32-C3 (BT107)', () => {
  it('scans the access point, connects and gets 192.168.4.2 from its DHCP server', () => {
    const { bench, text, mcu } = load('wifi-scan');
    runTo(bench, 8000, () => /connected .*\n/.test(text()));
    expect(text()).toContain('benchtop -50 3\nscan done 1\n');
    expect(text()).toContain('connected 192.168.4.2\n');
    expect(mcu().soc.periph.radioAccesses).toBe(0);
    const ap = bench.network?.accessPoints[0];
    expect(ap?.stations.size).toBe(1);
    expect([...(ap?.dhcp.leases.values() ?? [])]).toEqual([0xc0a80402]);
    expect(bench.mcuStopped('c3')).toBeNull();
  });

  it('the station uses the board’s MAC (Espressif’s 34:85:18 and a hash of the part id)', () => {
    const { bench, text, mcu } = load('wifi-scan');
    runTo(bench, 8000, () => /connected .*\n/.test(text()));
    const mac = mcu().soc.rtc.mac;
    expect(mac.slice(0, 3)).toEqual([0x34, 0x85, 0x18]);
    const station = [...bench.network!.accessPoints[0].stations.keys()][0];
    expect(station).toBe(mac.map((b) => b.toString(16).padStart(2, '0')).join(':'));
  });

  it('HTTPClient GETs and POSTs to the http-server part by name (DNS at the gateway, TCP to the part)', () => {
    const { bench, text } = load('wifi-http-get', { project: 'esp32c3-wifi-http' });
    runTo(bench, 10000, () => /POST .*\n/.test(text()));
    expect(text()).toContain('GET 200 {"hello":"world","count":1}\n');
    expect(text()).toContain('POST 200 ping\n');
    const server = bench.network!.serverHosts[0];
    expect(server.http.log.map((e) => `${e.method} ${e.path} ${e.status}`)).toEqual(['GET /api/hello 200', 'POST /api/echo 200']);
    expect(bench.network!.accessPoints[0].dns.asked).toContain('api.bench');
  });

  it('BT117: the C3 hosts an access point too (the same driver): client parts take addresses from its DHCP server and get its pages', () => {
    const { bench, text, mcu } = load('wifi-softap', { project: 'esp32c3-softap' });
    runTo(bench, 4000, () => text().split('\n').filter((l) => l.startsWith('assigned ')).length === 2);
    // Its station list is the C3's: 10 entries (ESP_WIFI_MAX_CONN_NUM).
    expect(text()).toContain(`layout ${AP_STA_EVENT.SIZE} ${AP_STA_EVENT.AID} ${AP_STA_EVENT.SIZE} ${STA_INFO.SIZE} ${STA_INFO.RSSI} ${STA_LIST_C3.SIZE} ${STA_LIST_C3.NUM}\n`);
    expect(text()).toMatch(/ap at 192\.168\.4\.1 34:85:18(:[0-9A-F]{2}){3}\n/);
    expect(bench.network?.softAccessPoints[0].config).toMatchObject({ ssid: 'benchtop-ap', security: 'wpa2', channel: 6 });
    expect(text().split('\n').filter((l) => l.startsWith('assigned ')).sort()).toEqual(['assigned 192.168.4.2', 'assigned 192.168.4.3']);
    bench.input('count', { kind: 'press' });
    runTo(bench, bench.now() / NS_PER_MS + 500, () => false);
    const visual = bench.collectFrame().parts.find(([id]) => id === 'count')?.[1];
    expect(visual).toMatchObject({ status: '200', body: '2' });
    expect(mcu().soc.periph.radioAccesses).toBe(0);
  });

  it('without symbols the closed driver touches the radio: esp32c3-wifi-no-symbols, once', () => {
    const { bench, problems } = load('wifi-scan', { symbols: false });
    runTo(bench, 1500, () => problems.some((p) => p.code === 'esp32c3-wifi-no-symbols'));
    const reported = problems.filter((p) => p.code === 'esp32c3-wifi-no-symbols');
    expect(reported).toHaveLength(1);
    expect(reported[0].message).toContain('needs the firmware');
  });
});
