import { describe, expect, it } from 'vitest';
import { DHCP_CLIENT_PORT, DHCP_SERVER_PORT, DhcpClient, DhcpServer } from './dhcp.ts';
import { IpHost } from './host.ts';
import { HttpServer, parseRoutes } from './http.ts';
import { type LanClock, type LanPort, VirtualLan } from './lan.ts';
import { BROADCAST_IP, BROADCAST_MAC, macString } from './packet.ts';
import type { SoftApConfig, WifiLink, WifiRadio } from './radio.ts';
import { GATEWAY_IP, type NetEvent, NetRuntime } from './runtime.ts';
import type { AccessPointRole, HttpClientRole } from './spec.ts';

// BT115: soft access points — a board hosting an AP on the bench — and the DHCP client the
// runtime's hosts use on one. The "board" here is TypeScript: its own LAN with a host at
// 192.168.4.1 (a DHCP server and an HTTP server on it), bridged to the soft AP as a board's AP
// interface would be.

function testClock(): LanClock & { advance(to: number): void; time: number } {
  const queue: { at: number; fn: () => void }[] = [];
  const clock = {
    time: 0,
    now: () => clock.time,
    schedule(at: number, fn: () => void) {
      queue.push({ at, fn });
    },
    advance(to: number) {
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (next === undefined || next.at > to) break;
        queue.shift();
        clock.time = next.at;
        next.fn();
      }
      clock.time = to;
    },
  };
  return clock;
}

const MS = 1_000_000;
const BOARD_AP_MAC = [0x24, 0x0a, 0xc4, 0x00, 0x00, 0x02];
const CONFIG: SoftApConfig = { ssid: 'softnet', password: 'secret12', security: 'wpa2', channel: 1, hidden: false, maxStations: 4 };

/** A wire straight to `out`: what a board's network interface is (every frame it sends leaves). */
function wire(clock: LanClock, out: (frame: Uint8Array) => void): VirtualLan {
  return { clock, send: (_from: LanPort, frame: Uint8Array) => out(frame), attach() {}, detach() {}, has: () => true } as unknown as VirtualLan;
}

/** A board's network stack behind its soft AP: a host at 192.168.4.1 with DHCP and HTTP servers. */
function fakeBoard(radio: WifiRadio, clock: LanClock, config = CONFIG) {
  let link: ReturnType<NonNullable<WifiRadio['hostAp']>> | undefined;
  const host = new IpHost(
    wire(clock, (frame) => link?.send(frame)),
    { mac: BOARD_AP_MAC, ip: GATEWAY_IP, netmask: 0xffffff00 },
  );
  const joined: string[] = [];
  const left: string[] = [];
  link = radio.hostAp?.(config, BOARD_AP_MAC, {
    receive: (frame) => host.deliver(frame),
    joined: (mac) => joined.push(macString(mac)),
    left: (mac) => left.push(macString(mac)),
  });
  const dhcp = new DhcpServer({ server: GATEWAY_IP, netmask: 0xffffff00, router: GATEWAY_IP, dns: GATEWAY_IP, first: 0xc0a80402, last: 0xc0a8040a, leaseSeconds: 7200 });
  host.bindUdp(DHCP_SERVER_PORT, (_from, data) => {
    const reply = dhcp.handle(data);
    if (reply !== undefined) host.sendUdp(reply.broadcast ? BROADCAST_IP : reply.ip, DHCP_SERVER_PORT, DHCP_CLIENT_PORT, reply.data, reply.broadcast ? BROADCAST_MAC : reply.mac);
  });
  const http = new HttpServer(host, 80, parseRoutes('GET /hello 200 text/plain hi from the board').routes);
  return { link, joined, left, http, dhcp };
}

/** A station's host (another board) on a radio: its own IpHost on the WifiLink it joins with. */
function station(radio: WifiRadio, clock: LanClock, mac: number[], bssid: readonly number[]) {
  let wifi: WifiLink | undefined;
  const host = new IpHost(
    wire(clock, (frame) => wifi?.send(frame)),
    { mac, ip: 0, netmask: 0 },
  );
  let lost = 0;
  wifi = radio.join(bssid, mac, (frame) => host.deliver(frame), () => lost++);
  return { host, wifi, lost: () => lost };
}

const clientRole = (network: string, url = 'http://192.168.4.1/hello'): HttpClientRole => ({ kind: 'http-client', network, url, method: 'GET', body: '', interval: 0 });

describe('soft access points (BT115)', () => {
  it('a board hosts an AP: other boards see it (not the host itself), join, take a lease from it, and are told when it goes', () => {
    const clock = testClock();
    const net = NetRuntime.build([], () => undefined, clock);
    const events: NetEvent[] = [];
    net.listen((e) => events.push(e));
    const board = fakeBoard(net.radioFor('host'), clock);
    expect(board.link).toBeDefined();
    expect(net.radioFor('host').accessPoints()).toEqual([]); // its own isn't in its scans
    const seen = net.radioFor('other').accessPoints();
    expect(seen).toEqual([{ ssid: 'softnet', bssid: BOARD_AP_MAC, channel: 1, rssi: -45, security: 'wpa2', password: 'secret12', hidden: false }]);
    const mac = [0x24, 0x0a, 0xc4, 0x11, 0x22, 0x33];
    const s = station(net.radioFor('other'), clock, mac, seen[0].bssid);
    expect(board.joined).toEqual(['24:0a:c4:11:22:33']);
    expect(board.link?.stations()).toEqual([mac]);
    const dhcp = new DhcpClient(s.host, 'other-board', () => {});
    dhcp.start();
    clock.advance(50 * MS);
    expect(dhcp.state).toBe('bound');
    expect(dhcp.lease).toMatchObject({ ip: 0xc0a80402, router: GATEWAY_IP, server: GATEWAY_IP });
    expect(s.host.ip).toBe(0xc0a80402);
    // The runtime saw the board's ACK and the station's hostname on the LAN.
    expect(net.stations()).toEqual([{ board: 'other', ap: 'host', ssid: 'softnet', mac: '24:0a:c4:11:22:33', ip: 0xc0a80402, hostname: 'other-board', since: 0 }]);
    expect(events).toEqual([expect.objectContaining({ kind: 'connected', board: 'other', ap: 'host', ip: 0xc0a80402 })]);
    // The board closes its AP: the station is dropped and told.
    board.link?.close();
    expect(s.lost()).toBe(1);
    expect(events.at(-1)).toMatchObject({ kind: 'disconnected', board: 'other', ap: 'host' });
    expect(net.radioFor('other').accessPoints()).toEqual([]);
    expect(net.softAccessPoints).toEqual([]);
  });

  it('turns stations away past its maximum; a station leaving tells the board', () => {
    const clock = testClock();
    const net = NetRuntime.build([], () => undefined, clock);
    const board = fakeBoard(net.radioFor('host'), clock, { ...CONFIG, maxStations: 1 });
    const radio = net.radioFor('other');
    const first = station(radio, clock, [2, 0, 0, 0, 0, 1], BOARD_AP_MAC);
    expect(first.wifi).toBeDefined();
    expect(radio.join(BOARD_AP_MAC, [2, 0, 0, 0, 0, 2], () => {}, () => {})).toBeUndefined();
    first.wifi?.leave();
    expect(board.left).toEqual(['02:00:00:00:00:01']);
    expect(board.link?.stations()).toEqual([]);
  });

  it('a client part on a soft AP waits for it, joins when a board hosts it, takes a DHCP lease and gets the page; waits again when it goes', () => {
    const clock = testClock();
    const net = NetRuntime.build([{ id: 'phone', type: 'http-client', props: {} }], () => clientRole('softnet'), clock);
    expect(net.problems()).toEqual([]); // a network no AP part has is a board's to host
    const events: NetEvent[] = [];
    net.listen((e) => events.push(e));
    const visual = (): unknown => {
      net.invalidate();
      const out: [string, unknown][] = [];
      net.collect(out as never);
      return out.find(([id]) => id === 'phone')?.[1];
    };
    expect(visual()).toMatchObject({ body: 'waiting for "softnet"' });
    net.input('phone', { kind: 'press' });
    expect(events.at(-1)).toMatchObject({ kind: 'got', part: 'phone', status: 0, error: 'not on "softnet" yet' });
    const board = fakeBoard(net.radioFor('host'), clock);
    expect(board.joined).toHaveLength(1); // the client part joined at once
    clock.advance(50 * MS); // its DHCP exchange with the board
    expect(net.clientHosts[0].host?.ip).toBe(0xc0a80402);
    net.input('phone', { kind: 'press' });
    clock.advance(150 * MS);
    expect(events.at(-1)).toMatchObject({ kind: 'got', part: 'phone', status: 200, body: 'hi from the board' });
    expect(board.http.count).toBe(1);
    board.link?.close();
    expect(net.clientHosts[0].host).toBeNull();
    expect(net.clientHosts[0].ready).toBe(false);
    // Hosted again (the board restarted its AP): the client part joins again.
    const again = fakeBoard(net.radioFor('host'), clock);
    expect(again.joined).toHaveLength(1);
  });

  it('a reset drops the soft APs (the boards host them again)', () => {
    const clock = testClock();
    const net = NetRuntime.build([], () => undefined, clock);
    fakeBoard(net.radioFor('host'), clock);
    expect(net.softAccessPoints).toHaveLength(1);
    net.reset();
    expect(net.softAccessPoints).toEqual([]);
    expect(net.radioFor('other').accessPoints()).toEqual([]);
  });

  it('the DHCP client against the bench’s own AP part: the gateway’s lease', () => {
    const clock = testClock();
    const role: AccessPointRole = { kind: 'access-point', ssid: 'benchtop', password: 'simulated', security: 'wpa2', channel: 6, rssi: -50, hidden: false, on: true, internet: false, allow: '', clock: 'off' };
    const net = NetRuntime.build([{ id: 'ap', type: 'wifi-ap', props: {} }], () => role, clock);
    const radio = net.radioFor('b');
    const s = station(radio, clock, [2, 0, 0, 0, 0, 7], radio.accessPoints()[0].bssid);
    const dhcp = new DhcpClient(s.host, 'b', () => {});
    dhcp.start();
    clock.advance(50 * MS);
    expect(dhcp.lease).toMatchObject({ ip: 0xc0a80402, netmask: 0xffffff00, router: GATEWAY_IP, dns: GATEWAY_IP });
    expect(s.host.router).toBe(GATEWAY_IP);
  });
});
