import { Bench, type BenchEnv, NS_PER_MS, parseProject, SymbolTable } from '@benchtop/core';
import { rp2040McuFactory, type Rp2040Mcu } from '@benchtop/rp2040';
import { describe, expect, it } from 'vitest';
import { readFixture, readFixtureText, withheldFirmware } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';
import { netSpecFor } from '../network/specs.ts';

// The published repository leaves the Pico W firmware out (THIRD_PARTY_NOTICES.md): skipped there, never here.
const WITHHELD = withheldFirmware('picow/blink.uf2') !== undefined;

// BT110: the Raspberry Pi Pico W on a full Bench — the factory makes its RP2040 with the CYW43
// from the board's pin map, the fixture's symbols answer the chip's driver, and the board's LED
// (WL_GPIO0) shows what the firmware set through the chip.

function load(firmware: string, symbols = true, project = 'picow-blink', apProps: Record<string, string> = {}) {
  const json = JSON.parse(readFixtureText(`fixtures/projects/${project}.json`));
  for (const part of json.parts) if (part.type === 'wifi-ap') part.props = { ...part.props, ...apProps };
  const parsed = parseProject(json);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const codes: string[] = [];
  let mcu: Rp2040Mcu | null = null;
  const env: BenchEnv = {
    part: benchEnvParts,
    createMcu: (board, id, report) => {
      const created = rp2040McuFactory(board, id, (p) => {
        codes.push(p.code);
        report?.(p);
      }) as Rp2040Mcu;
      mcu = created;
      return created;
    },
  };
  const bench = new Bench(parsed.doc, env, { netSpecFor });
  bench.attachFirmware('picow', { format: 'uf2', bytes: readFixture(`fixtures/firmware/picow/${firmware}.uf2`) });
  bench.reset();
  if (symbols) (mcu as Rp2040Mcu | null)?.useSymbols(SymbolTable.fromNm(readFixtureText(`fixtures/firmware/picow/${firmware}.syms.tsv`), true));
  let serial = '';
  bench.onSerial('picow', (bytes) => (serial += String.fromCharCode(...bytes)));
  const led: number[] = [];
  const runTo = (ms: number): void => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 5; t <= ms; t += 5) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) if (part === 'picow') led.push(visual.led as number);
    }
  };
  const send = (text: string): void => bench.sendSerial('picow', Uint8Array.from([...`${text}\n`].map((c) => c.charCodeAt(0))));
  const runUntil = (maxMs: number, done: () => boolean): void => {
    for (let t = bench.now() / NS_PER_MS + 10; t <= maxMs && !done(); t += 10) bench.runUntil(t * NS_PER_MS);
  };
  return { bench, runTo, runUntil, send, led, codes, serial: () => serial, mcu: (): Rp2040Mcu => mcu as unknown as Rp2040Mcu };
}

/**
 * "status <s> link <l> at <ms>" lines of the wifi-connect sketch, as [status, link, ms].
 * arduino-pico's CYW43 status() maps the driver's link: down → 0 (WL_IDLE_STATUS), join → 3 with
 * an address else 6, fail / no network / bad auth → 4 (WL_CONNECT_FAILED).
 */
function states(text: string): [number, number, number][] {
  return [...text.matchAll(/status (-?\d+) link (-?\d+) at (\d+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
}

describe.skipIf(WITHHELD)('Raspberry Pi Pico W on the bench (BT110)', () => {
  it('blink: the board’s LED lights and darkens through the CYW43', () => {
    const t = load('blink');
    t.runTo(1300);
    expect(t.led.filter((b) => b > 0.9).length).toBeGreaterThan(0);
    expect(t.led.at(-1)).toBe(1); // on again at 1.07 s
    expect(t.serial()).toContain('led 1');
    expect(t.codes).not.toContain('rp2040-cyw43-no-symbols');
  });

  it('without symbols: the Problem names what’s missing, the LED stays dark', () => {
    const t = load('blink', false);
    t.runTo(800);
    expect(t.codes).toContain('rp2040-cyw43-no-symbols');
    expect(t.led.every((b) => b === 0)).toBe(true);
  });
});

describe.skipIf(WITHHELD)('WiFi on the Pico W (BT111)', () => {
  it('scans the access point, joins it and gets 192.168.4.2 from its DHCP server', () => {
    const t = load('wifi-scan', true, 'picow-wifi');
    t.runUntil(8000, () => /connected .*\n/.test(t.serial()));
    expect(t.serial()).toContain('benchtop -50 4\nscan done 1\n'); // auth_mode 5 (WPA2) → ENC_TYPE_CCMP (4)
    expect(t.serial()).toContain('connected 192.168.4.2');
    const ap = t.bench.network?.accessPoints[0];
    expect(ap?.stations.size).toBe(1);
    expect([...(ap?.dhcp.leases.values() ?? [])]).toEqual([0xc0a80402]);
    const mac = t.mcu().cyw43?.associated?.ssid;
    expect(mac).toBe('benchtop');
    const station = [...(ap?.stations.keys() ?? [])][0];
    expect(station?.startsWith('28:cd:c1:')).toBe(true); // Raspberry Pi's OUI and a hash of the part id
    expect(t.codes).not.toContain('rp2040-cyw43-no-symbols');
  });

  it('HTTPClient GETs and POSTs to the http-server part by name (DNS at the gateway, TCP to the part)', () => {
    const t = load('wifi-http-get', true, 'picow-wifi-http');
    t.runUntil(10000, () => /POST .*\n/.test(t.serial()));
    expect(t.serial()).toContain('GET 200 {"hello":"world","count":1}');
    expect(t.serial()).toContain('POST 200 ping');
    const server = t.bench.network!.serverHosts[0];
    expect(server.http.log.map((e) => `${e.method} ${e.path} ${e.status}`)).toEqual(['GET /api/hello 200', 'POST /api/echo 200']);
    expect(t.bench.network!.accessPoints[0].dns.asked).toContain('api.bench');
  });

  it('a wrong key: AUTH, then the handshake fails — bad auth (-3), never an address', () => {
    const t = load('wifi-connect', true, 'picow-wifi');
    t.runUntil(3000, () => t.serial().includes('ready'));
    t.send('join benchtop wrong-password');
    t.runUntil(8000, () => states(t.serial()).some(([, link]) => link === -3));
    expect(t.serial()).toMatch(/begin 6 at/); // WiFi.mode() was called: begin doesn't wait
    expect(states(t.serial()).at(-1)?.slice(0, 2)).toEqual([4, -3]);
    t.runTo(t.bench.now() / NS_PER_MS + 3000);
    expect(t.serial()).not.toContain('ip ');
    expect(t.bench.network?.accessPoints[0].stations.size).toBe(0);
  });

  it('an SSID nobody has: no network (-2)', () => {
    const t = load('wifi-connect', true, 'picow-wifi');
    t.runUntil(3000, () => t.serial().includes('ready'));
    t.send('join nosuchnet simulated');
    t.runUntil(8000, () => states(t.serial()).some(([, link]) => link === -2));
    expect(states(t.serial()).at(-1)?.slice(0, 2)).toEqual([4, -2]);
  });

  it('joins, then WiFi.disconnect() leaves the AP: link down, off the LAN', () => {
    const t = load('wifi-connect', true, 'picow-wifi');
    t.runUntil(3000, () => t.serial().includes('ready'));
    t.send('join benchtop simulated');
    t.runUntil(12000, () => t.serial().includes('ip '));
    expect(t.serial()).toContain('ip 192.168.4.2');
    expect(states(t.serial()).at(-1)?.slice(0, 2)).toEqual([3, 1]); // connected; the driver's link: joined
    const ap = t.bench.network!.accessPoints[0];
    expect(ap.stations.size).toBe(1);
    t.send('leave');
    t.runTo(t.bench.now() / NS_PER_MS + 500);
    expect(states(t.serial()).at(-1)?.slice(0, 2)).toEqual([0, 0]);
    expect(ap.stations.size).toBe(0);
  });

  it('an AP switched off: the station drops it after 6 s without beacons', () => {
    const t = load('wifi-connect', true, 'picow-wifi');
    t.runUntil(3000, () => t.serial().includes('ready'));
    t.send('join benchtop simulated');
    t.runUntil(10000, () => t.serial().includes('ip '));
    const off = t.bench.now() / NS_PER_MS;
    t.bench.input('ap', { kind: 'key', key: 'set:on=0', down: true });
    t.runTo(off + 7000);
    const after = states(t.serial()).filter(([, , ms]) => ms > off);
    expect(after.at(-1)?.slice(0, 2)).toEqual([0, 0]);
    expect((after.at(-1)?.[2] ?? 0) - off).toBeGreaterThan(5900);
  });

  it('an open AP: a key for it finds no network (the chip prunes it); joined without one', () => {
    const t = load('wifi-connect', true, 'picow-wifi', { security: 'open' });
    t.runUntil(3000, () => t.serial().includes('ready'));
    t.send('join benchtop simulated');
    t.runUntil(8000, () => states(t.serial()).some(([, link]) => link === -2));
    expect(states(t.serial()).at(-1)?.slice(0, 2)).toEqual([4, -2]);
    t.send('join benchtop');
    t.runUntil(t.bench.now() / NS_PER_MS + 8000, () => t.serial().includes('ip '));
    expect(t.serial()).toContain('ip 192.168.4.2');
  });
});
