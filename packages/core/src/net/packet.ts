/**
 * Packet building blocks for the virtual network (BT98): big-endian fields, the Internet
 * checksum, Ethernet II, ARP, IPv4, ICMP echo and UDP — what the bench's hosts and lwIP exchange.
 * IPv4 addresses are unsigned 32-bit numbers (192.168.4.1 = 0xC0A80401), MACs arrays of 6 bytes.
 * Parsers take untrusted bytes (a firmware builds them): every length is checked, and a frame that
 * doesn't parse is undefined, never an exception.
 */

export type Mac = readonly number[];

export const ETH_HEADER = 14;
export const ETHERTYPE_IPV4 = 0x0800;
export const ETHERTYPE_ARP = 0x0806;
export const IP_HEADER = 20;
export const PROTO_ICMP = 1;
export const PROTO_TCP = 6;
export const PROTO_UDP = 17;
export const UDP_HEADER = 8;
export const BROADCAST_MAC: Mac = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
export const BROADCAST_IP = 0xffffffff;
/** The largest Ethernet payload a host sends (no jumbo frames, no fragmentation). */
export const MTU = 1500;

export function be16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

export function be32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

export function setBe16(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 8) & 0xff;
  b[o + 1] = v & 0xff;
}

export function setBe32(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

/** The ones'-complement sum of 16-bit words (RFC 1071), not yet complemented. */
export function sum16(b: Uint8Array, o: number, length: number, initial = 0): number {
  let sum = initial;
  for (let i = 0; i + 1 < length; i += 2) sum += (b[o + i] << 8) | b[o + i + 1];
  if ((length & 1) !== 0) sum += b[o + length - 1] << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return sum;
}

/** The Internet checksum of b[o, o + length) (0 when the bytes hold a correct checksum). */
export function checksum(b: Uint8Array, o: number, length: number, initial = 0): number {
  return ~sum16(b, o, length, initial) & 0xffff;
}

export function ipString(ip: number): string {
  return `${ip >>> 24}.${(ip >>> 16) & 0xff}.${(ip >>> 8) & 0xff}.${ip & 0xff}`;
}

/** A dotted quad, or undefined. */
export function parseIp(text: string): number | undefined {
  const parts = text.trim().split('.');
  if (parts.length !== 4) return undefined;
  let ip = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    ip = ip * 256 + n;
  }
  return ip >>> 0;
}

export function macString(mac: Mac): string {
  return mac.map((b) => b.toString(16).padStart(2, '0')).join(':');
}

export function macAt(b: Uint8Array, o: number): number[] {
  return [b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5]];
}

export function macIs(b: Uint8Array, o: number, mac: Mac): boolean {
  for (let i = 0; i < 6; i++) if (b[o + i] !== mac[i]) return false;
  return true;
}

/** A locally administered unicast MAC from a name (FNV-1a), so a part keeps its MAC across rebuilds. */
export function macFromName(name: string, prefix: readonly number[] = [0x02]): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const mac = [...prefix];
  for (let i = 0; mac.length < 6; i++) mac.push((Math.imul(h, i + 1) >>> (8 * (i % 4))) & 0xff);
  return mac;
}

// ── Ethernet II ─────────────────────────────────────────────────────────────────────────

export function ethernet(dst: Mac, src: Mac, type: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(ETH_HEADER + payload.length);
  frame.set(dst.slice(0, 6), 0);
  frame.set(src.slice(0, 6), 6);
  setBe16(frame, 12, type);
  frame.set(payload, ETH_HEADER);
  return frame;
}

export interface EthernetFrame {
  dst: number[];
  src: number[];
  type: number;
  payload: Uint8Array;
}

export function parseEthernet(frame: Uint8Array): EthernetFrame | undefined {
  if (frame.length < ETH_HEADER) return undefined;
  return { dst: macAt(frame, 0), src: macAt(frame, 6), type: be16(frame, 12), payload: frame.subarray(ETH_HEADER) };
}

// ── ARP (IPv4 over Ethernet) ────────────────────────────────────────────────────────────

export const ARP_REQUEST = 1;
export const ARP_REPLY = 2;

export interface ArpPacket {
  op: number;
  senderMac: number[];
  senderIp: number;
  targetMac: number[];
  targetIp: number;
}

export function arp(packet: ArpPacket): Uint8Array {
  const p = new Uint8Array(28);
  setBe16(p, 0, 1); // Ethernet
  setBe16(p, 2, ETHERTYPE_IPV4);
  p[4] = 6;
  p[5] = 4;
  setBe16(p, 6, packet.op);
  p.set(packet.senderMac.slice(0, 6), 8);
  setBe32(p, 14, packet.senderIp);
  p.set(packet.targetMac.slice(0, 6), 18);
  setBe32(p, 24, packet.targetIp);
  return p;
}

export function parseArp(p: Uint8Array): ArpPacket | undefined {
  if (p.length < 28 || be16(p, 0) !== 1 || be16(p, 2) !== ETHERTYPE_IPV4 || p[4] !== 6 || p[5] !== 4) return undefined;
  return { op: be16(p, 6), senderMac: macAt(p, 8), senderIp: be32(p, 14), targetMac: macAt(p, 18), targetIp: be32(p, 24) };
}

// ── IPv4 ────────────────────────────────────────────────────────────────────────────────

export interface Ipv4Packet {
  protocol: number;
  src: number;
  dst: number;
  ttl: number;
  id: number;
  payload: Uint8Array;
}

/** A 20-byte header (no options, don't-fragment set) and `payload`. */
export function ipv4(packet: { protocol: number; src: number; dst: number; payload: Uint8Array; ttl?: number; id?: number }): Uint8Array {
  const p = new Uint8Array(IP_HEADER + packet.payload.length);
  p[0] = 0x45;
  setBe16(p, 2, p.length);
  setBe16(p, 4, packet.id ?? 0);
  setBe16(p, 6, 0x4000); // DF
  p[8] = packet.ttl ?? 64;
  p[9] = packet.protocol;
  setBe32(p, 12, packet.src);
  setBe32(p, 16, packet.dst);
  setBe16(p, 10, checksum(p, 0, IP_HEADER));
  p.set(packet.payload, IP_HEADER);
  return p;
}

/** An IPv4 packet with a valid header checksum; fragments (MF or an offset) are undefined. */
export function parseIpv4(p: Uint8Array): Ipv4Packet | undefined {
  if (p.length < IP_HEADER || p[0] >> 4 !== 4) return undefined;
  const ihl = (p[0] & 15) * 4;
  const total = be16(p, 2);
  if (ihl < IP_HEADER || total < ihl || total > p.length || checksum(p, 0, ihl) !== 0) return undefined;
  if ((be16(p, 6) & 0x3fff) !== 0) return undefined;
  return { protocol: p[9], src: be32(p, 12), dst: be32(p, 16), ttl: p[8], id: be16(p, 4), payload: p.subarray(ihl, total) };
}

/** The TCP/UDP pseudo-header's sum (RFC 768/793). */
export function pseudoSum(src: number, dst: number, protocol: number, length: number): number {
  return sum16(Uint8Array.of(src >>> 24, (src >>> 16) & 255, (src >>> 8) & 255, src & 255, dst >>> 24, (dst >>> 16) & 255, (dst >>> 8) & 255, dst & 255, 0, protocol, length >>> 8, length & 255), 0, 12);
}

// ── ICMP ────────────────────────────────────────────────────────────────────────────────

export const ICMP_ECHO_REPLY = 0;
export const ICMP_ECHO_REQUEST = 8;

/** An echo request's reply: type 0, the same identifier, sequence and data. */
export function icmpEchoReply(request: Uint8Array): Uint8Array | undefined {
  if (request.length < 8 || request[0] !== ICMP_ECHO_REQUEST || checksum(request, 0, request.length) !== 0) return undefined;
  const reply = request.slice();
  reply[0] = ICMP_ECHO_REPLY;
  reply[2] = reply[3] = 0;
  setBe16(reply, 2, checksum(reply, 0, reply.length));
  return reply;
}

export function icmpEcho(type: number, id: number, seq: number, data: Uint8Array): Uint8Array {
  const p = new Uint8Array(8 + data.length);
  p[0] = type;
  setBe16(p, 4, id);
  setBe16(p, 6, seq);
  p.set(data, 8);
  setBe16(p, 2, checksum(p, 0, p.length));
  return p;
}

// ── UDP ─────────────────────────────────────────────────────────────────────────────────

export interface UdpDatagram {
  srcPort: number;
  dstPort: number;
  data: Uint8Array;
}

export function udp(src: number, dst: number, srcPort: number, dstPort: number, data: Uint8Array): Uint8Array {
  const p = new Uint8Array(UDP_HEADER + data.length);
  setBe16(p, 0, srcPort);
  setBe16(p, 2, dstPort);
  setBe16(p, 4, p.length);
  p.set(data, UDP_HEADER);
  const sum = checksum(p, 0, p.length, pseudoSum(src, dst, PROTO_UDP, p.length));
  setBe16(p, 6, sum === 0 ? 0xffff : sum);
  return p;
}

/** A datagram whose checksum (when not 0) is right. */
export function parseUdp(src: number, dst: number, p: Uint8Array): UdpDatagram | undefined {
  if (p.length < UDP_HEADER) return undefined;
  const length = be16(p, 4);
  if (length < UDP_HEADER || length > p.length) return undefined;
  if (be16(p, 6) !== 0 && checksum(p, 0, length, pseudoSum(src, dst, PROTO_UDP, length)) !== 0) return undefined;
  return { srcPort: be16(p, 0), dstPort: be16(p, 2), data: p.subarray(UDP_HEADER, length) };
}
