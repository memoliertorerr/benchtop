import { describe, expect, it } from 'vitest';
import { DHCP, DHCP_CLIENT_PORT, DHCP_SERVER_PORT, DhcpServer, parseDhcp } from './dhcp.ts';
import { IpHost } from './host.ts';
import { type LanClock, type LanPort, VirtualLan } from './lan.ts';
import {
  ARP_REPLY,
  ARP_REQUEST,
  arp,
  be16,
  be32,
  BROADCAST_MAC,
  checksum,
  ETH_HEADER,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ethernet,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  icmpEcho,
  ipString,
  ipv4,
  macFromName,
  parseArp,
  parseEthernet,
  parseIp,
  parseIpv4,
  parseUdp,
  PROTO_ICMP,
  PROTO_UDP,
  setBe16,
  udp,
} from './packet.ts';
import { GATEWAY_IP, NetRuntime } from './runtime.ts';
import type { AccessPointRole } from './spec.ts';

// BT98: the virtual network's TypeScript side, frame by frame against hand-built packets.

/** A clock whose scheduled callbacks run when `advance` passes them. */
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

/** A port that records what it gets. */
function sink(mac: number[]): LanPort & { frames: Uint8Array[]; times: number[]; clock: LanClock | undefined } {
  const port = {
    mac,
    frames: [] as Uint8Array[],
    times: [] as number[],
    clock: undefined as LanClock | undefined,
    deliver(frame: Uint8Array) {
      port.frames.push(frame);
      port.times.push(port.clock?.now() ?? 0);
    },
  };
  return port;
}

const STATION = [0x24, 0x0a, 0xc4, 0x11, 0x22, 0x33];
const GATEWAY_MAC = [0x02, 0, 0, 0, 0, 0x01];
const STATION_IP = 0xc0a80402;

describe('packets (BT98)', () => {
  it('computes the Internet checksum as RFC 1071 does', () => {
    const bytes = Uint8Array.of(0x00, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7);
    expect(checksum(bytes, 0, bytes.length)).toBe(0x220d);
    // An odd length pads with a zero byte.
    expect(checksum(Uint8Array.of(0x01), 0, 1)).toBe(0xfeff);
  });

  it('builds IPv4 headers that verify, and refuses bad checksums and fragments', () => {
    const packet = ipv4({ protocol: PROTO_UDP, src: STATION_IP, dst: GATEWAY_IP, payload: Uint8Array.of(1, 2, 3), id: 7 });
    expect(checksum(packet, 0, 20)).toBe(0);
    expect(parseIpv4(packet)).toMatchObject({ protocol: PROTO_UDP, src: STATION_IP, dst: GATEWAY_IP, id: 7, ttl: 64 });
    const bad = packet.slice();
    bad[8]--;
    expect(parseIpv4(bad)).toBeUndefined();
    const fragment = packet.slice();
    setBe16(fragment, 6, 0x2000); // MF
    setBe16(fragment, 10, 0);
    setBe16(fragment, 10, checksum(fragment, 0, 20));
    expect(parseIpv4(fragment)).toBeUndefined();
    expect(parseIpv4(packet.subarray(0, 10))).toBeUndefined();
  });

  it('checks UDP checksums over the pseudo-header', () => {
    const datagram = udp(STATION_IP, GATEWAY_IP, 5000, 53, Uint8Array.of(9, 8, 7));
    expect(parseUdp(STATION_IP, GATEWAY_IP, datagram)).toMatchObject({ srcPort: 5000, dstPort: 53 });
    expect(parseUdp(STATION_IP, GATEWAY_IP + 1, datagram)).toBeUndefined();
    const unchecked = datagram.slice();
    unchecked[6] = unchecked[7] = 0;
    expect(parseUdp(STATION_IP, GATEWAY_IP + 1, unchecked)?.data).toEqual(Uint8Array.of(9, 8, 7));
  });

  it('parses and formats addresses; names give stable, locally administered MACs', () => {
    expect(parseIp('192.168.4.1')).toBe(GATEWAY_IP);
    expect(ipString(GATEWAY_IP)).toBe('192.168.4.1');
    expect(parseIp('192.168.4')).toBeUndefined();
    expect(parseIp('192.168.4.256')).toBeUndefined();
    const a = macFromName('wifi-ap:ap');
    expect(a).toEqual(macFromName('wifi-ap:ap'));
    expect(a).not.toEqual(macFromName('wifi-ap:ap2'));
    expect(a[0]).toBe(0x02);
    expect(macFromName('esp', [0x24, 0x0a, 0xc4]).slice(0, 3)).toEqual([0x24, 0x0a, 0xc4]);
  });
});

describe('a host on the LAN (BT98)', () => {
  function setup() {
    const clock = testClock();
    const lan = new VirtualLan(clock);
    const host = new IpHost(lan, { mac: GATEWAY_MAC, ip: GATEWAY_IP, netmask: 0xffffff00 });
    lan.attach(host, false);
    const station = sink(STATION);
    station.clock = clock;
    lan.attach(station, true);
    return { clock, lan, host, station };
  }

  it('answers ARP for its address after one radio hop, and only for its own', () => {
    const { clock, lan, host, station } = setup();
    lan.send(station, ethernet(BROADCAST_MAC, STATION, ETHERTYPE_ARP, arp({ op: ARP_REQUEST, senderMac: STATION, senderIp: STATION_IP, targetMac: [0, 0, 0, 0, 0, 0], targetIp: GATEWAY_IP })));
    lan.send(station, ethernet(BROADCAST_MAC, STATION, ETHERTYPE_ARP, arp({ op: ARP_REQUEST, senderMac: STATION, senderIp: 0, targetMac: [0, 0, 0, 0, 0, 0], targetIp: 0xc0a80409 })));
    clock.advance(10_000_000);
    expect(station.frames).toHaveLength(1);
    const eth = parseEthernet(station.frames[0]);
    expect(eth?.dst).toEqual(STATION);
    expect(eth?.type).toBe(ETHERTYPE_ARP);
    expect(parseArp(eth!.payload)).toEqual({ op: ARP_REPLY, senderMac: GATEWAY_MAC, senderIp: GATEWAY_IP, targetMac: STATION, targetIp: STATION_IP });
    // It learned the station; the probe (sender 0.0.0.0) taught it nothing.
    expect(host.arpTable.get(STATION_IP)).toEqual(STATION);
    expect(host.arpTable.size).toBe(1);
  });

  it('answers an echo request with the same identifier, sequence and data', () => {
    const { clock, lan, host, station } = setup();
    const data = Uint8Array.from({ length: 32 }, (_, i) => i);
    const request = ipv4({ protocol: PROTO_ICMP, src: STATION_IP, dst: GATEWAY_IP, payload: icmpEcho(ICMP_ECHO_REQUEST, 0x1234, 7, data) });
    lan.send(station, ethernet(GATEWAY_MAC, STATION, ETHERTYPE_IPV4, request));
    clock.advance(10_000_000);
    expect(host.echoes).toBe(1);
    const reply = parseIpv4(parseEthernet(station.frames[0])!.payload)!;
    expect([reply.src, reply.dst, reply.protocol]).toEqual([GATEWAY_IP, STATION_IP, PROTO_ICMP]);
    expect(checksum(reply.payload, 0, reply.payload.length)).toBe(0);
    expect(reply.payload[0]).toBe(ICMP_ECHO_REPLY);
    expect([be16(reply.payload, 4), be16(reply.payload, 6)]).toEqual([0x1234, 7]);
    expect(reply.payload.subarray(8)).toEqual(data);
    // Two radio hops in all: the request in, the reply out (≥ 2 × 100 µs).
    expect(station.times[0]).toBeGreaterThan(200_000);
  });

  it('asks ARP before sending to an unknown neighbour, then sends what waited', () => {
    const { clock, lan, host, station } = setup();
    host.sendUdp(STATION_IP, 67, 68, Uint8Array.of(1));
    clock.advance(10_000_000);
    expect(station.frames).toHaveLength(1);
    expect(parseEthernet(station.frames[0])?.type).toBe(ETHERTYPE_ARP);
    lan.send(station, ethernet(GATEWAY_MAC, STATION, ETHERTYPE_ARP, arp({ op: ARP_REPLY, senderMac: STATION, senderIp: STATION_IP, targetMac: GATEWAY_MAC, targetIp: GATEWAY_IP })));
    clock.advance(20_000_000);
    expect(station.frames).toHaveLength(2);
    const packet = parseIpv4(parseEthernet(station.frames[1])!.payload)!;
    expect(parseUdp(packet.src, packet.dst, packet.payload)).toMatchObject({ srcPort: 67, dstPort: 68 });
  });
});

describe('the LAN (BT98)', () => {
  it('keeps a station’s frames in order to another station, through the AP, and drops them for one that left', () => {
    const clock = testClock();
    const lan = new VirtualLan(clock);
    const a = sink([2, 0, 0, 0, 0, 0xa]);
    const b = sink([2, 0, 0, 0, 0, 0xb]);
    a.clock = b.clock = clock;
    lan.attach(a, true);
    lan.attach(b, true);
    const long = ethernet(b.mac, a.mac, ETHERTYPE_IPV4, new Uint8Array(1400));
    const short = ethernet(b.mac, a.mac, ETHERTYPE_IPV4, new Uint8Array(10));
    lan.send(a, long);
    lan.send(a, short);
    clock.advance(10_000_000);
    expect(b.frames).toEqual([long, short]);
    // 1400 bytes: 100 µs + 210 µs a hop, two hops.
    expect(b.times[0]).toBeCloseTo(2 * (100_000 + (1414 * 8 * 1e9) / 54e6), -2);
    expect(b.times[1]).toBeGreaterThan(b.times[0]);
    // Broadcasts reach everyone but the sender; a port that left gets nothing in flight.
    lan.send(a, ethernet(BROADCAST_MAC, a.mac, ETHERTYPE_ARP, new Uint8Array(28)));
    lan.detach(b);
    clock.advance(20_000_000);
    expect(b.frames).toHaveLength(2);
    expect(a.frames).toHaveLength(0);
    expect(lan.frames).toBe(3);
  });
});

/** A DHCP client message. */
function dhcpMessage(type: number, mac: number[], options: { requested?: number; server?: number; ciaddr?: number; xid?: number } = {}): Uint8Array {
  const p = new Uint8Array(300);
  p[0] = 1;
  p[1] = 1;
  p[2] = 6;
  p.set([0x12, 0x34, 0x56, (options.xid ?? 0x78) & 0xff], 4);
  if (options.ciaddr !== undefined) p.set([options.ciaddr >>> 24, (options.ciaddr >>> 16) & 255, (options.ciaddr >>> 8) & 255, options.ciaddr & 255], 12);
  p.set(mac, 28);
  p.set([0x63, 0x82, 0x53, 0x63], 236);
  const opts = [53, 1, type];
  const ip = (v: number): number[] => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  if (options.requested !== undefined) opts.push(50, 4, ...ip(options.requested));
  if (options.server !== undefined) opts.push(54, 4, ...ip(options.server));
  opts.push(12, 5, ...[...'esp32'].map((c) => c.charCodeAt(0)), 255);
  p.set(opts, 240);
  return p;
}

/** The message type and yiaddr of a server reply. */
function replyOf(data: Uint8Array): { type: number; yiaddr: number; options: Map<number, Uint8Array> } {
  const options = new Map<number, Uint8Array>();
  for (let i = 240; i < data.length && data[i] !== 255; ) {
    if (data[i] === 0) {
      i++;
      continue;
    }
    options.set(data[i], data.subarray(i + 2, i + 2 + data[i + 1]));
    i += 2 + data[i + 1];
  }
  return { type: options.get(53)![0], yiaddr: be32(data, 16), options };
}

describe('the DHCP server (BT98)', () => {
  const config = { server: GATEWAY_IP, netmask: 0xffffff00, router: GATEWAY_IP, dns: GATEWAY_IP, first: 0xc0a80402, last: 0xc0a80404, leaseSeconds: 7200 };

  it('offers the next free address, ACKs a request for it, and hands out the router, mask and DNS', () => {
    const server = new DhcpServer(config);
    const offer = server.handle(dhcpMessage(DHCP.DISCOVER, STATION))!;
    expect(offer.broadcast).toBe(true);
    expect(replyOf(offer.data)).toMatchObject({ type: DHCP.OFFER, yiaddr: 0xc0a80402 });
    expect(be32(offer.data, 4)).toBe(0x12345678); // the client's transaction id
    const ack = replyOf(server.handle(dhcpMessage(DHCP.REQUEST, STATION, { requested: 0xc0a80402, server: GATEWAY_IP }))!.data);
    expect(ack.type).toBe(DHCP.ACK);
    expect(ack.yiaddr).toBe(0xc0a80402);
    expect([...ack.options.get(1)!]).toEqual([255, 255, 255, 0]);
    expect([...ack.options.get(3)!]).toEqual([192, 168, 4, 1]);
    expect([...ack.options.get(6)!]).toEqual([192, 168, 4, 1]);
    expect(be32(ack.options.get(51)!, 0)).toBe(7200);
    expect(server.hostnames.get('24:0a:c4:11:22:33')).toBe('esp32');
    // The same client asks again (a reboot): the same address.
    expect(replyOf(server.handle(dhcpMessage(DHCP.DISCOVER, STATION))!.data).yiaddr).toBe(0xc0a80402);
  });

  it('NAKs a request for an address that isn’t the client’s, skips declined ones, frees released ones', () => {
    const server = new DhcpServer(config);
    const other = [2, 0, 0, 0, 0, 9];
    server.handle(dhcpMessage(DHCP.DISCOVER, STATION));
    expect(replyOf(server.handle(dhcpMessage(DHCP.REQUEST, other, { requested: 0xc0a80402 }))!.data).type).toBe(DHCP.NAK);
    // A renewal from a client that has its address comes back unicast.
    const renew = server.handle(dhcpMessage(DHCP.REQUEST, STATION, { ciaddr: 0xc0a80402 }))!;
    expect(renew.broadcast).toBe(false);
    expect(renew.ip).toBe(0xc0a80402);
    // The other client finds .3 in use (its ARP check) and declines: it gets .4.
    expect(replyOf(server.handle(dhcpMessage(DHCP.DISCOVER, other))!.data).yiaddr).toBe(0xc0a80403);
    server.handle(dhcpMessage(DHCP.DECLINE, other, { requested: 0xc0a80403 }));
    expect(replyOf(server.handle(dhcpMessage(DHCP.DISCOVER, other))!.data).yiaddr).toBe(0xc0a80404);
    // The pool (.2–.4) is full until someone releases.
    const third = [2, 0, 0, 0, 0, 10];
    expect(server.handle(dhcpMessage(DHCP.DISCOVER, third))).toBeUndefined();
    server.handle(dhcpMessage(DHCP.RELEASE, STATION));
    expect(replyOf(server.handle(dhcpMessage(DHCP.DISCOVER, third))!.data).yiaddr).toBe(0xc0a80402);
    expect(parseDhcp(new Uint8Array(100))).toBeUndefined();
  });
});

describe('the bench network (BT98)', () => {
  const role: AccessPointRole = { kind: 'access-point', ssid: 'benchtop', password: 'simulated', security: 'wpa2', channel: 6, rssi: -50, hidden: false, on: true };
  const build = (clock: LanClock, previous: NetRuntime | null = null): NetRuntime =>
    NetRuntime.build([{ id: 'ap', type: 'wifi-ap', props: {} }, { id: 'led', type: 'led', props: {} }], (type) => (type === 'wifi-ap' ? role : undefined), clock, previous);

  it('gives a station a lease over its LAN, drops it when the AP goes off, and shows it', () => {
    const clock = testClock();
    const net = build(clock);
    expect(net.owns('ap')).toBe(true);
    expect(net.owns('led')).toBe(false);
    const ap = net.radio.accessPoints()[0];
    expect(ap).toMatchObject({ ssid: 'benchtop', channel: 6, security: 'wpa2' });
    const got: Uint8Array[] = [];
    let lost = 0;
    const link = net.radio.join(ap.bssid, STATION, (frame) => got.push(frame), () => lost++)!;
    link.send(ethernet(BROADCAST_MAC, STATION, ETHERTYPE_IPV4, ipv4({ protocol: PROTO_UDP, src: 0, dst: 0xffffffff, payload: udp(0, 0xffffffff, DHCP_CLIENT_PORT, DHCP_SERVER_PORT, dhcpMessage(DHCP.DISCOVER, STATION)) })));
    clock.advance(10_000_000);
    expect(got).toHaveLength(1);
    const offer = parseIpv4(got[0].subarray(ETH_HEADER))!;
    expect(replyOf(parseUdp(offer.src, offer.dst, offer.payload)!.data).type).toBe(DHCP.OFFER);
    const frames: [string, unknown][] = [];
    net.collect(frames as never);
    expect(frames).toEqual([['ap', { on: true, ssid: 'benchtop', stations: 1, clients: '192.168.4.2 (esp32)' }]]);
    net.collect((frames.length = 0, frames) as never);
    expect(frames).toEqual([]); // nothing changed
    net.input('ap', { kind: 'key', key: 'set:on=0', down: true });
    expect(lost).toBe(1);
    expect(net.radio.accessPoints()).toEqual([]);
    expect(net.radio.join(ap.bssid, STATION, () => {}, () => {})).toBeUndefined();
    net.input('ap', { kind: 'press' });
    expect(net.radio.accessPoints()).toHaveLength(1);
    // A rebuild keeps the AP's leases; a reset forgets them.
    const next = build(clock, net);
    expect(next.accessPoints[0].dhcp.leases.get('24:0a:c4:11:22:33')).toBe(0xc0a80402);
    next.reset();
    expect(next.accessPoints[0].dhcp.leases.size).toBe(0);
  });
});
