import { describe, expect, it } from 'vitest';
import { IpHost } from './host.ts';
import type { LanClock } from './lan.ts';
import { GATEWAY_IP, NetRuntime } from './runtime.ts';
import { isNtpName, NTP_PORT, ntpTimestamp, sntpAnswer } from './sntp.ts';
import type { AccessPointRole } from './spec.ts';

// BT105: the gateway's SNTP server — packets by hand, then over the virtual LAN.

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

/** An SNTP client request (mode 3, version 4) whose transmit timestamp is `marker`. */
function request(marker: number): Uint8Array {
  const p = new Uint8Array(48);
  p[0] = (4 << 3) | 3;
  p[2] = 6;
  p.set([marker >>> 24, (marker >>> 16) & 0xff, (marker >>> 8) & 0xff, marker & 0xff, 1, 2, 3, 4], 40);
  return p;
}

const DATE = Date.parse('2026-01-02T03:04:05Z');

describe('SNTP (BT105)', () => {
  it('answers a mode 3 request in mode 4, stratum 2, the client’s timestamp as originate, and nothing else', () => {
    const answer = sntpAnswer(request(0xcafe0001), DATE + 1500, DATE)!;
    expect(answer.length).toBe(48);
    expect(answer[0]).toBe((4 << 3) | 4);
    expect(answer[1]).toBe(2);
    expect([...answer.subarray(24, 32)]).toEqual([0xca, 0xfe, 0x00, 0x01, 1, 2, 3, 4]);
    expect(ntpTimestamp(answer, 40)).toBe(DATE + 1500);
    expect(ntpTimestamp(answer, 32)).toBe(DATE + 1500);
    expect(ntpTimestamp(answer, 16)).toBe(DATE);
    const server = request(1);
    server[0] = (4 << 3) | 4;
    expect(sntpAnswer(server, DATE, DATE)).toBeUndefined();
    expect(sntpAnswer(new Uint8Array(20), DATE, DATE)).toBeUndefined();
    expect(['pool.ntp.org', '0.pool.ntp.org', 'europe.pool.ntp.org', 'time.google.com'].every(isNtpName)).toBe(true);
    expect(isNtpName('ntp.org')).toBe(false);
  });

  const ap = (clock: string): AccessPointRole => ({ kind: 'access-point', ssid: 'benchtop', password: 'simulated', security: 'wpa2', channel: 6, rssi: -50, hidden: false, on: true, internet: false, allow: '', clock });
  const lan = (clock: string) => {
    const t = testClock();
    const net = NetRuntime.build([{ id: 'ap', type: 'wifi-ap', props: {} }], () => ap(clock), t);
    const gateway = net.accessPoints[0];
    const station = new IpHost(gateway.lan, { mac: [0x24, 0x0a, 0xc4, 1, 2, 3], ip: 0xc0a80402, netmask: 0xffffff00 });
    gateway.lan.attach(station, true);
    const answers: Uint8Array[] = [];
    station.bindUdp(40123, (_from, data) => answers.push(data));
    return { t, net, gateway, station, answers };
  };

  it('the gateway serves the AP’s clock: a fixed date plus bench time; pool.ntp.org resolves to it', () => {
    const { t, net, gateway, station, answers } = lan('2026-01-02T03:04:05Z');
    expect(net.problems()).toEqual([]);
    expect(gateway.resolve('pool.ntp.org')).toBe(GATEWAY_IP);
    expect(gateway.resolve('2.pool.ntp.org')).toBe(GATEWAY_IP);
    t.advance(2_500_000_000);
    station.sendUdp(GATEWAY_IP, 40123, NTP_PORT, request(7));
    t.advance(2_510_000_000);
    expect(answers).toHaveLength(1);
    const served = ntpTimestamp(answers[0], 40);
    expect(served).toBeGreaterThanOrEqual(DATE + 2500);
    expect(served).toBeLessThan(DATE + 2510);
    expect(gateway.sntpAnswered).toBe(1);
    // A reset starts the clock over at the date.
    net.reset();
    expect(gateway.clockBase).toBe(DATE);
  });

  it('wall: the host’s clock at the start; off: no answer and no names; a bad value says so and keeps the host’s time', () => {
    const before = Date.now();
    const wall = lan('wall');
    expect(wall.gateway.clockBase).toBeGreaterThanOrEqual(before);
    expect(wall.gateway.clockBase).toBeLessThanOrEqual(Date.now());
    const off = lan('off');
    expect(off.gateway.resolve('pool.ntp.org')).toBeUndefined();
    off.station.sendUdp(GATEWAY_IP, 40123, NTP_PORT, request(1));
    off.t.advance(10_000_000);
    expect(off.answers).toEqual([]);
    const bad = lan('yesterday');
    expect(bad.net.problems().map((p) => p.code)).toEqual(['net-clock']);
    expect(bad.gateway.clockBase).toBeGreaterThanOrEqual(before);
  });
});
