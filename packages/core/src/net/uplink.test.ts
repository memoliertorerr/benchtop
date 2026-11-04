import { describe, expect, it } from 'vitest';
import { utf8Bytes } from './http.ts';
import type { LanClock } from './lan.ts';
import type { NetEvent } from './runtime.ts';
import { NetRuntime } from './runtime.ts';
import type { NetRole } from './spec.ts';
import { allows, parseAllowList, type Uplink, type UplinkEvents } from './uplink.ts';

// BT101: the real network through a host's uplink — allow lists, DNS for allowed names, the
// gateway's transparent proxy (SYN-ACK only once the far end is open), refusals, the pump.

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

/** An uplink the test drives: it records connects and what was sent, and answers when told. */
function fakeUplink(pump = false) {
  const opened: { host: string; port: number; events: UplinkEvents; sent: string[]; ended: boolean; closed: boolean }[] = [];
  let pumps = 0;
  const uplink: Uplink = {
    connect(host, port, events) {
      const c = { host, port, events, sent: [] as string[], ended: false, closed: false };
      opened.push(c);
      return {
        send: (bytes) => c.sent.push(new TextDecoder().decode(bytes)),
        end: () => (c.ended = true),
        close: () => (c.closed = true),
      };
    },
    ...(pump ? { pump: () => pumps++ } : {}),
  };
  return { uplink, opened, pumps: () => pumps };
}

describe('allow lists (BT101)', () => {
  it('parses host:port entries a line or a comma apart, and says what it skipped', () => {
    expect(parseAllowList('api.example.com:443, 93.184.216.34:80\n# a comment\nAPI.Example.com.:443\n  \n')).toEqual({
      entries: [
        { host: 'api.example.com', port: 443 },
        { host: '93.184.216.34', port: 80 },
      ],
      errors: [],
    });
    expect(parseAllowList('example.com, *.example.com:80, x:0, x:99999, a b:1, https://x:443').errors).toEqual([
      '"example.com" isn\'t host:port',
      '"*.example.com:80" isn\'t host:port',
      '"x:0" isn\'t host:port',
      '"x:99999" isn\'t host:port',
      '"a b:1" isn\'t host:port',
      '"https://x:443" isn\'t host:port',
    ]);
    expect(parseAllowList(Array.from({ length: 40 }, (_, i) => `h${i}:1`).join(',')).errors).toEqual(['more than 32 entries']);
    const list = parseAllowList('api.example.com:443').entries;
    expect(allows(list, 'API.EXAMPLE.COM.', 443)).toBe(true);
    expect(allows(list, 'api.example.com', 80)).toBe(false);
    expect(allows(list, 'example.com', 443)).toBe(false);
  });
});

describe('the gateway to the real network (BT101)', () => {
  const ap = (internet: boolean, allow: string): NetRole => ({ kind: 'access-point', ssid: 'benchtop', password: 'simulated', security: 'wpa2', channel: 6, rssi: -50, hidden: false, on: true, internet, allow, clock: 'off' });
  const client = (url: string): NetRole => ({ kind: 'http-client', network: '', url, method: 'GET', body: '', interval: 0 });
  const build = (roles: Record<string, NetRole>, uplink: Uplink | null, clock = testClock()) => {
    const net = NetRuntime.build(
      Object.keys(roles).map((id) => ({ id, type: id, props: {} })),
      (type) => roles[type],
      clock,
      null,
      uplink,
    );
    const events: NetEvent[] = [];
    net.listen((e) => events.push(e));
    return { net, clock, events, got: () => events.filter((e) => e.kind === 'got') };
  };

  it('answers allowed names with 198.18.x.y and proxies TCP to them once the far end is open', () => {
    const fake = fakeUplink();
    const { net, clock, got } = build({ ap: ap(true, 'api.example.com:80, 10.9.8.7:8080'), web: client('http://api.example.com/hello'), lit: client('http://10.9.8.7:8080/x') }, fake.uplink);
    const gateway = net.accessPoints[0];
    expect(gateway.resolve('API.example.com')).toBe(0xc6120001);
    expect(gateway.resolve('other.example.com')).toBeUndefined();
    net.input('web', { kind: 'press' });
    clock.advance(10_000_000);
    // The request waits: no SYN-ACK until the uplink says the far end is open.
    expect(fake.opened.map((c) => `${c.host}:${c.port}`)).toEqual(['api.example.com:80']);
    expect(fake.opened[0].sent).toEqual([]);
    expect(gateway.visual()).toMatchObject({ internet: 'busy' });
    fake.opened[0].events.opened();
    clock.advance(20_000_000);
    expect(fake.opened[0].sent.join('')).toMatch(/^GET \/hello HTTP\/1\.1\r\nHost: api\.example\.com\r\n/);
    fake.opened[0].events.data(utf8Bytes('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nworld'));
    fake.opened[0].events.closed(null);
    clock.advance(40_000_000);
    expect(got().map((e) => [e.part, e.status, e.body])).toEqual([['web', 200, 'world']]);
    expect(gateway.visual()).toMatchObject({ internet: 'on' });
    // An allowed address goes without DNS.
    net.input('lit', { kind: 'press' });
    clock.advance(50_000_000);
    expect(fake.opened.map((c) => `${c.host}:${c.port}`)).toEqual(['api.example.com:80', '10.9.8.7:8080']);
    expect(net.liveProblems()).toEqual([]);
  });

  it('refusals: an RST for what the list doesn\'t allow (the uplink never asked), the uplink\'s own refusal as a problem', () => {
    const fake = fakeUplink();
    const { net, clock, got } = build({ ap: ap(true, 'api.example.com:80'), port: client('http://api.example.com:81/'), ip: client('http://10.1.1.1/'), ok: client('http://api.example.com/') }, fake.uplink);
    net.input('port', { kind: 'press' });
    net.input('ip', { kind: 'press' });
    clock.advance(10_000_000);
    expect(fake.opened).toEqual([]);
    expect(got().map((e) => [e.part, e.error])).toEqual([
      ['port', 'connection refused or reset'],
      ['ip', 'connection refused or reset'],
    ]);
    net.input('ok', { kind: 'press' });
    clock.advance(20_000_000);
    fake.opened[0].events.closed("api.example.com:80 isn't on the bridge's --network list");
    clock.advance(30_000_000);
    expect(got().map((e) => [e.part, e.error]).slice(2)).toEqual([['ok', 'connection refused or reset']]);
    expect(net.liveProblems()).toEqual([{ severity: 'warning', code: 'net-internet', message: "ap couldn't reach api.example.com:80: api.example.com:80 isn't on the bridge's --network list.", parts: ['ap'] }]);
    expect(net.accessPoints[0].visual()).toMatchObject({ internet: 'error' });
    // A reset forgets it.
    net.reset();
    expect(net.liveProblems()).toEqual([]);
    expect(net.accessPoints[0].visual()).toMatchObject({ internet: 'on' });
  });

  it('is off unless the AP says so: no names, no proxy, and the build says what is missing', () => {
    const fake = fakeUplink();
    const off = build({ ap: ap(false, 'api.example.com:80') }, fake.uplink);
    expect(off.net.accessPoints[0].resolve('api.example.com')).toBeUndefined();
    expect(off.net.accessPoints[0].visual()).toMatchObject({ internet: 'off' });
    expect(off.net.problems()).toEqual([]);
    expect(build({ ap: ap(true, 'nonsense') }, fake.uplink).net.problems().map((p) => p.message)).toEqual([
      'ap\'s allow list: "nonsense" isn\'t host:port — write one host:port a line, e.g. api.example.com:443.',
      'ap lets boards reach the internet but allows no host: add host:port lines to its allow list.',
    ]);
    expect(build({ ap: ap(true, 'api.example.com:80') }, null).net.problems().map((p) => p.code)).toEqual(['net-no-uplink']);
  });

  it('pumps a synchronous uplink every simulated millisecond while a connection is out, and closes its sockets on a reset', () => {
    const fake = fakeUplink(true);
    const { net, clock } = build({ ap: ap(true, 'api.example.com:80'), web: client('http://api.example.com/') }, fake.uplink);
    net.input('web', { kind: 'press' });
    clock.advance(10_000_000);
    expect(fake.pumps()).toBeGreaterThanOrEqual(8);
    const before = fake.pumps();
    net.reset();
    expect(fake.opened[0].closed).toBe(true);
    clock.advance(30_000_000);
    expect(fake.pumps()).toBe(before);
  });
});
