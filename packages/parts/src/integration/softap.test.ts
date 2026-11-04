import { assembleBench, type Bench, type BenchEnv, type FirmwareImage, NS_PER_MS, type NetEvent, type ProjectDoc, SymbolTable, type VisualState } from '@benchtop/core';
import { type Esp32Mcu, esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../esp32/src/test-support/rom.test-helper.ts';
import { AP_STA_EVENT, STA_INFO, STA_LIST } from '../../../esp32/src/wifi/types.ts';
import { benchEnvParts } from '../catalog.ts';
import { netSpecFor } from '../network/specs.ts';

// BT116: the ESP32's soft-AP — WiFi.softAP hosts an access point on the bench (no access-point
// part), the firmware's own lwIP and DHCP server answer the stations on it: client parts, and
// another ESP32. fixtures/sketches/esp32/wifi-softap, softap-client and wifi-apsta.

const ROM = loadCachedRom();
const esp32 = esp32McuFactory(ROM);

function image(name: string): FirmwareImage {
  return { format: 'esp32-bin', app: readFixture(`fixtures/firmware/esp32/${name}.bin`), partitions: readFixture(`fixtures/firmware/esp32/${name}.partitions.bin`) };
}

/** A bench of `project` with each board's firmware (and its symbols); `edit` rebuilds it with carry-over (BT78). */
function load(project: string, firmware: Record<string, string>) {
  const mcus = new Map<string, Esp32Mcu>();
  const env: BenchEnv = {
    part: benchEnvParts,
    createMcu: (board, id, report) => {
      const mcu = esp32(board, id, report) as Esp32Mcu;
      mcu.useSymbols(SymbolTable.fromNm(readFixtureText(`fixtures/firmware/esp32/${firmware[id]}.syms.tsv`)));
      mcus.set(id, mcu);
      return mcu;
    },
  };
  const images = Object.fromEntries(Object.entries(firmware).map(([id, name]) => [id, image(name)]));
  const doc = JSON.parse(readFixtureText(`fixtures/projects/${project}.json`)) as ProjectDoc;
  let bench: Bench = assembleBench(doc, env, images, { netSpecFor });
  const serial: Record<string, string> = {};
  const events: NetEvent[] = [];
  const latest = new Map<string, VisualState>();
  const listen = (b: Bench): void => {
    for (const id of Object.keys(firmware)) {
      serial[id] ??= '';
      b.onSerial(id, (bytes) => (serial[id] += String.fromCharCode(...bytes)));
    }
    b.network?.listen((e) => events.push(e));
  };
  listen(bench);
  const collect = (): void => {
    for (const [part, visual] of bench.collectFrame().parts) latest.set(part, structuredClone(visual));
  };
  return {
    bench: () => bench,
    text: (id: string) => serial[id] ?? '',
    mcu: (id: string): Esp32Mcu => mcus.get(id)!,
    events,
    latest,
    /** Runs in 10 ms slices until `done` or `maxMs`. */
    runTo(maxMs: number, done: () => boolean = () => false): void {
      for (let t = Math.floor(bench.now() / NS_PER_MS) + 10; t <= maxMs && !done(); t += 10) {
        bench.runUntil(t * NS_PER_MS);
        collect();
      }
    },
    press(part: string): void {
      bench.input(part, { kind: 'press' });
    },
    edit(next: ProjectDoc): void {
      bench = assembleBench(next, env, images, { netSpecFor, carry: bench.carry() });
      listen(bench);
      collect();
    },
    doc,
  };
}

const lines = (text: string, pattern: RegExp): string[] => text.split(/\r?\n/).filter((l) => pattern.test(l));

describe('the ESP32 hosts an access point (BT116)', () => {
  it('WiFi.softAP: client parts on its network take addresses from its DHCP server and get its pages', () => {
    const r = load('esp32-softap', { esp: 'wifi-softap' });
    r.runTo(3000, () => /ap at .*\n/.test(r.text('esp')));
    // The event and station-list layouts this toolchain builds (types.ts holds them).
    expect(lines(r.text('esp'), /^layout /)).toEqual([`layout ${AP_STA_EVENT.SIZE} ${AP_STA_EVENT.AID} ${AP_STA_EVENT.SIZE} ${STA_INFO.SIZE} ${STA_INFO.RSSI} ${STA_LIST.SIZE} ${STA_LIST.NUM}`]);
    const apMac = /ap at 192\.168\.4\.1 ([0-9A-F:]{17})/.exec(r.text('esp'))?.[1];
    expect(apMac).toBeDefined();
    const soft = r.bench().network?.softAccessPoints[0];
    expect(soft?.config).toEqual({ ssid: 'benchtop-ap', password: 'simulated1', security: 'wpa2', channel: 6, hidden: false, maxStations: 4 });
    expect(soft?.bssid.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':')).toBe(apMac);
    // Both client parts joined (two AIDs) and asked its DHCP server for an address.
    r.runTo(4000, () => lines(r.text('esp'), /^assigned /).length === 2);
    const joined = lines(r.text('esp'), /^joined /);
    expect(joined.map((l) => l.replace(/^joined \S+ /, ''))).toEqual(['aid 1', 'aid 2']);
    expect(lines(r.text('esp'), /^assigned /).sort()).toEqual(['assigned 192.168.4.2', 'assigned 192.168.4.3']);
    r.runTo(4200);
    // esp_wifi_ap_get_sta_list: both, with the RSSI the AP hears.
    const list = lines(r.text('esp'), /^stations /).at(-1);
    expect(list).toMatch(/^stations 2: [0-9a-f:]{17} -45 [0-9a-f:]{17} -45$/);
    r.press('page');
    r.runTo(4600);
    expect(r.latest.get('page')).toMatchObject({ status: '200', body: 'hello from the ap', sent: 1 });
    r.press('count');
    r.runTo(5000);
    expect(r.latest.get('count')).toMatchObject({ status: '200', body: '2' });
    expect(lines(r.text('esp'), /^GET /)).toEqual(['GET /', 'GET /stations']);
    expect(r.mcu('esp').soc.periph.radioAccesses).toBe(0);
  }, 60_000);

  it('a second ESP32 joins it (no access-point part): DHCP from the first, three GETs, then leaves', () => {
    const r = load('esp32-softap-two', { host: 'wifi-softap', guest: 'softap-client' });
    r.runTo(12000, () => r.text('guest').includes('left'));
    expect(r.text('guest')).toContain('connected 192.168.4.2 gateway 192.168.4.1\n');
    expect(lines(r.text('guest'), /^GET /)).toEqual(['GET 200 hello from the ap', 'GET 200 hello from the ap', 'GET 200 hello from the ap']);
    r.runTo(r.bench().now() / NS_PER_MS + 300);
    const host = r.text('host');
    const mac = /joined ([0-9a-f:]{17}) aid 1/.exec(host)?.[1];
    expect(mac).toBeDefined();
    expect(host).toContain('assigned 192.168.4.2\n');
    expect(lines(host, /^GET /)).toEqual(['GET /', 'GET /', 'GET /']);
    expect(host).toContain(`left ${mac} aid 1\n`);
    expect(lines(host, /^stations /)).toEqual([`stations 1: ${mac} -45`, 'stations 0:']);
    // The runtime saw the guest's lease on the host's AP, and its leaving.
    expect(r.events.filter((e) => e.kind === 'connected' || e.kind === 'disconnected').map((e) => [e.kind, (e as { board: string }).board, (e as { ap: string }).ap])).toEqual([
      ['connected', 'guest', 'host'],
      ['disconnected', 'guest', 'host'],
    ]);
    expect(r.bench().network?.stations()).toEqual([]);
  }, 60_000);

  it('AP+STA: on the bench’s access point while hosting its own (another subnet); a client part on its AP gets its station address', () => {
    const r = load('esp32-apsta', { esp: 'wifi-apsta' });
    r.runTo(8000, () => /sta 192.*\n/.test(r.text('esp')));
    expect(r.text('esp')).toContain('ap at 192.168.5.1\n');
    expect(r.text('esp')).toContain('sta 192.168.4.2\n');
    expect(r.bench().network?.accessPoints[0].stations.size).toBe(1);
    expect(r.bench().network?.softAccessPoints[0].config).toMatchObject({ ssid: 'bridge-ap', security: 'open', password: '' });
    r.runTo(9000);
    expect(r.bench().network?.clientHosts[0].host?.ip).toBe(0xc0a80502); // from the board's DHCP server
    r.press('phone');
    r.runTo(9500);
    expect(r.latest.get('phone')).toMatchObject({ status: '200', body: 'sta 192.168.4.2' });
  }, 60_000);

  it('a rebuild (an edit while it runs) keeps the AP, its stations and their leases: nobody joins or leaves again', () => {
    const r = load('esp32-softap', { esp: 'wifi-softap' });
    r.runTo(5000, () => lines(r.text('esp'), /^assigned /).length === 2);
    r.runTo(r.bench().now() / NS_PER_MS + 200);
    const before = r.text('esp');
    const next = structuredClone(r.doc);
    next.parts.find((p) => p.id === 'page')!.props = { ...next.parts.find((p) => p.id === 'page')!.props, url: 'http://192.168.4.1/stations' };
    r.edit(next);
    expect(r.bench().carriedBoard('esp')).toBe(true);
    r.press('page');
    r.runTo(r.bench().now() / NS_PER_MS + 500);
    expect(r.latest.get('page')).toMatchObject({ status: '200', body: '2' });
    const after = r.text('esp').slice(before.length);
    expect(lines(after, /^(joined|left|assigned) /)).toEqual([]);
    expect(r.bench().network?.softAccessPoints).toHaveLength(1);
    expect(r.bench().network?.softAccessPoints[0].stations.size).toBe(2);
  }, 60_000);

  it('a reset drops the AP; the firmware hosts it again and the client parts join it again', () => {
    const r = load('esp32-softap', { esp: 'wifi-softap' });
    r.runTo(5000, () => lines(r.text('esp'), /^assigned /).length === 2);
    r.bench().reset();
    const at = r.text('esp').length;
    expect(r.bench().network?.softAccessPoints).toEqual([]);
    r.runTo(r.bench().now() / NS_PER_MS + 4000, () => lines(r.text('esp').slice(at), /^assigned /).length === 2);
    expect(lines(r.text('esp').slice(at), /^joined /)).toHaveLength(2);
    r.press('page');
    r.runTo(r.bench().now() / NS_PER_MS + 400);
    expect(r.latest.get('page')).toMatchObject({ status: '200', body: 'hello from the ap' });
  }, 60_000);
});
