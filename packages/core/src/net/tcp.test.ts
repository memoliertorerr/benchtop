import { describe, expect, it } from 'vitest';
import { DnsServer, dnsQuery, parseDnsQuery } from './dns.ts';
import { IpHost } from './host.ts';
import { HttpServer, httpRequest, type HttpResult, parseHttpUrl, parseRequest, parseRoutes, utf8Bytes, utf8String } from './http.ts';
import { type LanClock, type LanPort, VirtualLan } from './lan.ts';
import { be16, be32, ETH_HEADER, ETHERTYPE_IPV4, ethernet, ipv4, parseEthernet, parseIpv4, PROTO_TCP } from './packet.ts';
import { type NetEvent, NetRuntime } from './runtime.ts';
import type { NetRole } from './spec.ts';
import { parseTcp, TCP, tcpSegment } from './tcp.ts';

// BT99: TCP, DNS and HTTP on the virtual LAN, frame by frame and host to host.

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

const A_IP = 0xc0a8040a;
const B_IP = 0xc0a8040b;
const A_MAC = [2, 0, 0, 0, 0, 0x0a];
const B_MAC = [2, 0, 0, 0, 0, 0x0b];

function twoHosts() {
  const clock = testClock();
  const lan = new VirtualLan(clock);
  const a = new IpHost(lan, { mac: A_MAC, ip: A_IP, netmask: 0xffffff00 });
  const b = new IpHost(lan, { mac: B_MAC, ip: B_IP, netmask: 0xffffff00 });
  lan.attach(a, false);
  lan.attach(b, true);
  return { clock, lan, a, b };
}

/** A port that records the TCP segments it gets (a hand-driven peer). */
function peer(mac: number[]): LanPort & { segments: ReturnType<typeof parseTcp>[] } {
  const port = {
    mac,
    segments: [] as ReturnType<typeof parseTcp>[],
    deliver(frame: Uint8Array) {
      const ip = parseIpv4(parseEthernet(frame)!.payload);
      if (ip?.protocol === PROTO_TCP) port.segments.push(parseTcp(ip.src, ip.dst, ip.payload));
    },
  };
  return port;
}

describe('TCP segments (BT99)', () => {
  it('builds and parses segments with the MSS option and a checksum over the pseudo-header', () => {
    const seg = tcpSegment(A_IP, B_IP, { srcPort: 1234, dstPort: 80, seq: 1000, ack: 0, flags: TCP.SYN, window: 5744, mss: 1436 });
    expect(seg.length).toBe(24);
    expect(parseTcp(A_IP, B_IP, seg)).toMatchObject({ srcPort: 1234, dstPort: 80, seq: 1000, flags: TCP.SYN, window: 5744, mss: 1436 });
    expect(parseTcp(A_IP, B_IP + 1, seg)).toBeUndefined();
    const data = tcpSegment(A_IP, B_IP, { srcPort: 1, dstPort: 2, seq: 0xfffffff0, ack: 5, flags: TCP.ACK | TCP.PSH, window: 100, data: Uint8Array.of(1, 2, 3) });
    expect(parseTcp(A_IP, B_IP, data)?.data).toEqual(Uint8Array.of(1, 2, 3));
  });
});

describe('TCP between two hosts (BT99)', () => {
  it('opens, carries data both ways past the window, and closes from either side', () => {
    const { clock, a, b } = twoHosts();
    const received: number[] = [];
    let serverSide: ReturnType<typeof b.connectTcp> | undefined;
    b.listenTcp(7000, (connection) => {
      serverSide = connection;
      connection.ondata = (data) => connection.send(data.map((x) => x ^ 0xff)); // echo, inverted
      connection.onpeerclose = () => connection.close();
    });
    const client = a.connectTcp(B_IP, 7000);
    let opened = false;
    let ended = '';
    client.onopen = () => (opened = true);
    client.ondata = (data) => received.push(...data);
    client.onend = (why) => (ended = why);
    clock.advance(10_000_000);
    expect(opened).toBe(true);
    expect(serverSide?.state).toBe('established');
    // 20 000 bytes: many MSS-sized segments, both ways.
    const payload = Uint8Array.from({ length: 20_000 }, (_, i) => i & 0xff);
    client.send(payload);
    clock.advance(200_000_000);
    expect(received.length).toBe(20_000);
    expect(received.every((x, i) => x === ((i & 0xff) ^ 0xff))).toBe(true);
    client.close();
    clock.advance(300_000_000);
    expect(ended).toBe('closed');
    expect(serverSide?.state).toBe('closed');
    expect(a.connections).toBe(0);
    expect(b.connections).toBe(0);
  });

  it('respects the peer’s window: no more in flight than it advertised until it ACKs', () => {
    const clock = testClock();
    const lan = new VirtualLan(clock);
    const host = new IpHost(lan, { mac: A_MAC, ip: A_IP, netmask: 0xffffff00 });
    lan.attach(host, false);
    const station = peer(B_MAC);
    lan.attach(station, true);
    const send = (s: Parameters<typeof tcpSegment>[2]): void => lan.send(station, ethernet(A_MAC, B_MAC, ETHERTYPE_IPV4, ipv4({ protocol: PROTO_TCP, src: B_IP, dst: A_IP, payload: tcpSegment(B_IP, A_IP, s) })));
    host.arpTable.set(B_IP, B_MAC);
    host.listenTcp(80, (connection) => connection.send(new Uint8Array(5000)));
    send({ srcPort: 5555, dstPort: 80, seq: 100, ack: 0, flags: TCP.SYN, window: 2000, mss: 1000 });
    clock.advance(5_000_000);
    const synAck = station.segments[0]!;
    expect(synAck.flags).toBe(TCP.SYN | TCP.ACK);
    expect(synAck.ack).toBe(101);
    send({ srcPort: 5555, dstPort: 80, seq: 101, ack: synAck.seq + 1, flags: TCP.ACK, window: 2000 });
    clock.advance(10_000_000);
    // Two segments of the peer's MSS (1000) fill its 2000-byte window; the rest waits.
    const data = station.segments.slice(1);
    expect(data.map((s) => s!.data.length)).toEqual([1000, 1000]);
    send({ srcPort: 5555, dstPort: 80, seq: 101, ack: synAck.seq + 1 + 2000, flags: TCP.ACK, window: 2000 });
    clock.advance(20_000_000);
    expect(station.segments.slice(3).map((s) => s!.data.length)).toEqual([1000, 1000]);
    // An unknown port answers RST.
    send({ srcPort: 5556, dstPort: 81, seq: 7, ack: 0, flags: TCP.SYN, window: 100 });
    clock.advance(30_000_000);
    const rst = station.segments.at(-1)!;
    expect(rst.flags & TCP.RST).toBe(TCP.RST);
    expect(rst.ack).toBe(8);
  });

  it('sends unacknowledged data again after 1 s, and gives up after five tries', () => {
    const clock = testClock();
    const lan = new VirtualLan(clock);
    const host = new IpHost(lan, { mac: A_MAC, ip: A_IP, netmask: 0xffffff00 });
    lan.attach(host, false);
    const station = peer(B_MAC);
    lan.attach(station, true);
    host.arpTable.set(B_IP, B_MAC);
    const client = host.connectTcp(B_IP, 80);
    let ended = '';
    client.onend = (why) => (ended = why);
    clock.advance(3_500_000_000);
    // The SYN and its retries at 1 s, 2 s and 3 s.
    expect(station.segments.filter((s) => s!.flags === TCP.SYN)).toHaveLength(4);
    clock.advance(10_000_000_000);
    expect(ended).toBe('timeout');
  });
});

describe('DNS (BT99)', () => {
  it('answers A questions for its names, NXDOMAIN for others, nothing for other types', () => {
    const names = new Map([['api.bench', A_IP]]);
    const server = new DnsServer((name) => names.get(name));
    const query = dnsQuery(0x4242, 'API.Bench.');
    expect(parseDnsQuery(query)).toMatchObject({ id: 0x4242, name: 'api.bench', type: 1, qclass: 1 });
    const answer = server.handle(query)!;
    expect(be16(answer, 0)).toBe(0x4242);
    expect(answer[3] & 15).toBe(0);
    expect(be16(answer, 6)).toBe(1); // ANCOUNT
    expect(be32(answer, answer.length - 4)).toBe(A_IP);
    expect(server.handle(dnsQuery(1, 'nope.bench'))![3] & 15).toBe(3);
    const aaaa = server.handle(dnsQuery(2, 'api.bench', 28))!;
    expect([aaaa[3] & 15, be16(aaaa, 6)]).toEqual([0, 0]);
    expect(server.handle(Uint8Array.of(1, 2, 0x80))).toBeUndefined();
  });
});

describe('HTTP (BT99)', () => {
  it('parses routes and requests', () => {
    const { routes, errors } = parseRoutes('# comment\nGET / 200 text/html <b>hi</b>\npost /api/* 201 application/json {"ok":true}\nnot a route\n');
    expect(routes).toEqual([
      { method: 'GET', path: '/', status: 200, type: 'text/html', body: '<b>hi</b>' },
      { method: 'POST', path: '/api/*', status: 201, type: 'application/json', body: '{"ok":true}' },
    ]);
    expect(errors).toHaveLength(1);
    expect(parseRequest(utf8Bytes('GET /x?y=1 HTTP/1.1\r\nHost: a\r\n'))).toBe('incomplete');
    const parsed = parseRequest(utf8Bytes('POST /x?y=1 HTTP/1.1\r\nContent-Length: 3\r\n\r\nabcd'));
    expect(parsed).toMatchObject({ request: { method: 'POST', path: '/x', query: 'y=1' }, length: 46 });
    expect(parseRequest(utf8Bytes('POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n'))).toEqual({ error: 411 });
  });

  it('serves its routes to a client host: placeholders, 404, 405, HEAD, and a log', () => {
    const { clock, a, b } = twoHosts();
    const server = new HttpServer(a, 80, parseRoutes('GET /hello 200 text/plain hi {{client}} #{{count}}\nPOST /echo 200 text/plain {{body}}').routes);
    const results: (HttpResult | string)[] = [];
    httpRequest(b, A_IP, 80, { method: 'GET', path: '/hello' }, (r) => results.push(r));
    clock.advance(100_000_000);
    httpRequest(b, A_IP, 80, { method: 'POST', path: '/echo', body: utf8Bytes('héllo') }, (r) => results.push(r));
    clock.advance(200_000_000);
    httpRequest(b, A_IP, 80, { method: 'GET', path: '/missing' }, (r) => results.push(r));
    httpRequest(b, A_IP, 80, { method: 'DELETE', path: '/hello' }, (r) => results.push(r));
    httpRequest(b, A_IP, 80, { method: 'HEAD', path: '/hello' }, (r) => results.push(r));
    clock.advance(500_000_000);
    const view = results.map((r) => (typeof r === 'string' ? r : [r.status, utf8String(r.body)]));
    expect(view).toEqual([
      [200, 'hi 192.168.4.11 #1'],
      [200, 'héllo'],
      [404, 'Not Found\n'],
      [405, 'Method Not Allowed\n'],
      [200, ''],
    ]);
    expect((results[0] as HttpResult).headers.get('content-type')).toBe('text/plain');
    expect(server.log.map((e) => `${e.method} ${e.path} ${e.status}`)).toEqual(['GET /hello 200', 'POST /echo 200', 'GET /missing 404', 'DELETE /hello 405', 'HEAD /hello 200']);
    expect(a.connections + b.connections).toBe(0);
    // A port nobody listens on refuses.
    httpRequest(b, A_IP, 8080, { method: 'GET', path: '/' }, (r) => results.push(r));
    clock.advance(800_000_000);
    expect(results.at(-1)).toBe('connection refused or reset');
    expect(ETH_HEADER).toBe(14);
  });
});

describe('server parts on the bench network (BT99)', () => {
  const roles: Record<string, NetRole> = {
    ap: { kind: 'access-point', ssid: 'benchtop', password: 'simulated', security: 'wpa2', channel: 6, rssi: -50, hidden: false, on: true, internet: false, allow: '', clock: 'off' },
    api: { kind: 'http-server', network: '', address: 0, port: 80, hostname: 'api.bench', routes: 'GET /api/hello 200 application/json {"hello":"world"}' },
    web: { kind: 'http-server', network: 'benchtop', address: 0xc0a8040a, port: 8080, hostname: 'web.bench', routes: 'GET / 200 text/html ok\nbogus line' },
    lost: { kind: 'http-server', network: 'elsewhere', address: 0, port: 80, hostname: '', routes: '' },
  };
  const parts = Object.keys(roles).map((id) => ({ id, type: id, props: {} }));

  it('places servers on their AP’s LAN, answers their names over DNS and serves a station', () => {
    const clock = testClock();
    const net = NetRuntime.build(parts, (type) => roles[type], clock);
    // "web" asked for .10; "api" takes the next free one; "lost" has no AP with its SSID.
    expect(net.serverHosts.map((s) => [s.id, s.host.ip])).toEqual([
      ['api', 0xc0a8040b],
      ['web', 0xc0a8040a],
    ]);
    expect(net.problems().map((p) => [p.code, p.parts[0]])).toEqual([
      ['http-routes', 'web'],
      ['net-no-access-point', 'lost'],
    ]);
    const ap = net.accessPoints[0];
    expect(ap.dhcp.reserved.has(0xc0a8040a)).toBe(true);
    // A station on the LAN: asks the gateway for api.bench, then GETs from it.
    const station = new IpHost(ap.lan, { mac: [0x24, 0x0a, 0xc4, 1, 2, 3], ip: 0xc0a80402, netmask: 0xffffff00 });
    ap.lan.attach(station, true);
    let resolved = 0;
    station.bindUdp(5353, (_from, data) => (resolved = be32(data, data.length - 4)));
    station.sendUdp(0xc0a80401, 5353, 53, dnsQuery(9, 'API.bench'));
    clock.advance(10_000_000);
    expect(resolved).toBe(0xc0a8040b);
    const results: (HttpResult | string)[] = [];
    httpRequest(station, resolved, 80, { method: 'GET', path: '/api/hello' }, (r) => results.push(r));
    clock.advance(100_000_000);
    expect(results.map((r) => (typeof r === 'string' ? r : [r.status, utf8String(r.body)]))).toEqual([[200, '{"hello":"world"}']]);
    const frames: [string, unknown][] = [];
    net.collect(frames as never);
    expect(frames.find(([id]) => id === 'api')?.[1]).toEqual({ address: '192.168.4.11:80', hostname: 'api.bench', requests: 1, log: 'GET /api/hello → 200' });
    // A reset forgets the log.
    net.reset();
    expect(net.serverHosts[0].http.count).toBe(0);
  });
});

describe('client parts, events and requests from the gateway (BT100)', () => {
  it('parses http:// URLs and says why it won’t send to others', () => {
    expect(parseHttpUrl('http://esp32-web/')).toEqual({ host: 'esp32-web', port: 80, path: '/' });
    expect(parseHttpUrl('  esp32-web/led?state=on ')).toEqual({ host: 'esp32-web', port: 80, path: '/led?state=on' });
    expect(parseHttpUrl('HTTP://192.168.4.2:8080')).toEqual({ host: '192.168.4.2', port: 8080, path: '/' });
    expect(parseHttpUrl('http://x?y=1#top')).toEqual({ host: 'x', port: 80, path: '/?y=1' });
    expect(parseHttpUrl('https://x/')).toMatch(/https isn't simulated/);
    expect(parseHttpUrl('ftp://x/')).toBe('not an http:// URL');
    expect(parseHttpUrl('http://bad host/')).toBe('not an http:// URL');
    expect(parseHttpUrl('http://x:0/')).toMatch(/outside 1–65535/);
    expect(parseHttpUrl('http://x:99999/')).toMatch(/outside 1–65535/);
  });

  const roles: Record<string, NetRole> = {
    ap: { kind: 'access-point', ssid: 'benchtop', password: 'simulated', security: 'wpa2', channel: 6, rssi: -50, hidden: false, on: true, internet: false, allow: '', clock: 'off' },
    api: { kind: 'http-server', network: '', address: 0, port: 80, hostname: 'api.bench', routes: 'GET /api/hello 200 application/json {"n":{{count}}}\nPOST /echo 200 text/plain got {{body}}' },
    poll: { kind: 'http-client', network: '', url: 'http://api.bench/api/hello?x=1', method: 'GET', body: '', interval: 500 },
    post: { kind: 'http-client', network: '', url: 'http://192.168.4.10/echo', method: 'POST', body: 'hi', interval: 0 },
    nobody: { kind: 'http-client', network: '', url: 'http://esp32-web/', method: 'GET', body: '', interval: 0 },
    bad: { kind: 'http-client', network: '', url: 'https://secure/', method: 'GET', body: '', interval: 0 },
  };
  const parts = Object.keys(roles).map((id) => ({ id, type: id, props: {} }));

  it('sends a client part’s request on a timer and when pressed, and reports what the servers answered', () => {
    const clock = testClock();
    const net = NetRuntime.build(parts, (type) => roles[type], clock);
    expect(net.problems().map((p) => [p.code, p.parts[0]])).toEqual([['http-url', 'bad']]);
    // Servers and clients share the automatic addresses: api .10, then the clients .11 on.
    expect(net.serverHosts.map((h) => h.host.ip)).toEqual([0xc0a8040a]);
    expect(net.clientHosts.map((h) => [h.id, h.host?.ip])).toEqual([
      ['poll', 0xc0a8040b],
      ['post', 0xc0a8040c],
      ['nobody', 0xc0a8040d],
      ['bad', 0xc0a8040e],
    ]);
    expect(net.owns('poll')).toBe(true);
    const events: NetEvent[] = [];
    net.listen((e) => events.push(e));
    net.reset(); // as a bench does after building: the timer starts with time
    clock.advance(1_200_000_000);
    const got = events.filter((e) => e.kind === 'got');
    expect(got.map((e) => [e.part, e.status, e.body])).toEqual([
      ['poll', 200, '{"n":1}'],
      ['poll', 200, '{"n":2}'],
    ]);
    expect(got[0].at).toBeGreaterThan(500_000_000);
    expect(got[0].at).toBeLessThan(510_000_000);
    const served = events.filter((e) => e.kind === 'served');
    expect(served[0]).toMatchObject({ part: 'api', method: 'GET', path: '/api/hello', query: 'x=1', status: 200, client: 0xc0a8040b });
    // Pressed: the POST goes by address; a name nobody has fails at once; https never leaves.
    net.input('post', { kind: 'press' });
    net.input('nobody', { kind: 'press' });
    net.input('bad', { kind: 'press' });
    clock.advance(1_300_000_000);
    expect(events.filter((e) => e.kind === 'got').slice(2).map((e) => [e.part, e.status, e.error === '' ? e.body : e.error])).toEqual([
      ['nobody', 0, 'no host "esp32-web" on "benchtop" (not a server part\'s hostname or a joined board\'s)'],
      ['bad', 0, "https isn't simulated: use http://"],
      ['post', 200, 'got hi'],
    ]);
    const frames: [string, Record<string, unknown>][] = [];
    net.collect(frames as never);
    expect(frames.find(([id]) => id === 'poll')?.[1]).toEqual({ url: 'http://api.bench/api/hello?x=1', method: 'GET', status: '200', body: '{"n":2}', sent: 2, busy: false });
    expect(frames.find(([id]) => id === 'nobody')?.[1]).toMatchObject({ status: 'error', body: expect.stringMatching(/^no host/) });
    // A reset starts the timer over and forgets the answers; a disposed network sends nothing.
    net.reset();
    expect(net.clientHosts[0]).toMatchObject({ sent: 0, status: 0, body: '' });
    clock.advance(clock.time + 600_000_000);
    expect(net.clientHosts[0].sent).toBe(1);
    net.dispose();
    const before = events.length;
    clock.advance(clock.time + 2_000_000_000);
    expect(events.length).toBe(before);
    expect(net.clientHosts[0].sent).toBe(1);
  });

  it('sends a request from the gateway (sim_http) by name or address, and says why one can’t go', () => {
    const clock = testClock();
    const net = NetRuntime.build(parts.slice(0, 2), (type) => roles[type], clock);
    const results: (HttpResult | string)[] = [];
    net.request('', 'POST', 'http://API.bench/echo', utf8Bytes('x'), { 'X-Test': '1' }, (r) => results.push(r));
    net.request('benchtop', 'GET', 'http://192.168.4.10/nope', new Uint8Array(0), {}, (r) => results.push(r));
    net.request('other', 'GET', 'http://api.bench/', new Uint8Array(0), {}, (r) => results.push(r));
    clock.advance(100_000_000);
    expect(results.map((r) => (typeof r === 'string' ? r : [r.status, utf8String(r.body)]))).toEqual([
      'no access point has the SSID "other"',
      [200, 'got x'],
      [404, 'Not Found\n'],
    ]);
    net.input('ap', { kind: 'release' });
    net.request('', 'GET', 'http://api.bench/', new Uint8Array(0), {}, (r) => results.push(r));
    expect(results.at(-1)).toBe('the access point "benchtop" is off');
    const empty = NetRuntime.build([], (type) => roles[type], clock);
    empty.request('', 'GET', 'http://x/', new Uint8Array(0), {}, (r) => results.push(r));
    expect(results.at(-1)).toBe('the bench has no WiFi access point');
  });
});
