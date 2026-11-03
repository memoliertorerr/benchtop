/**
 * A host on a virtual LAN (BT98): an IPv4 endpoint in TypeScript — the access point's gateway,
 * the server parts, the bench's own tools. It answers ARP for its address and learns the sender
 * of every ARP and IPv4 frame it gets; answers ICMP echo; hands UDP datagrams to the handler
 * bound to their port; runs TCP (BT99, tcp.ts): listeners accept connections on their port, a
 * SYN for a port nobody listens on (or a segment for no connection) gets RST, `connectTcp` opens
 * from an ephemeral port (49152 on). Sending resolves the next hop's MAC from what it learned, or
 * asks with an ARP request and sends once the reply comes (a few packets wait; more are dropped,
 * as an ARP queue would). Packets for other addresses are ignored (it doesn't route — yet).
 */

import type { LanClock, LanPort, VirtualLan } from './lan.ts';
import { parseTcp, TCP, TcpConnection, type TcpOwner, tcpSegment } from './tcp.ts';
import {
  ARP_REPLY,
  ARP_REQUEST,
  arp,
  BROADCAST_IP,
  BROADCAST_MAC,
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ethernet,
  ICMP_ECHO_REQUEST,
  icmpEchoReply,
  ipv4,
  type Mac,
  parseArp,
  parseEthernet,
  parseIpv4,
  parseUdp,
  PROTO_ICMP,
  PROTO_TCP,
  PROTO_UDP,
  udp,
} from './packet.ts';

export interface UdpSource {
  ip: number;
  port: number;
  mac: number[];
}

export type UdpHandler = (from: UdpSource, data: Uint8Array) => void;

const ARP_QUEUE = 8;

export class IpHost implements LanPort, TcpOwner {
  readonly mac: Mac;
  readonly ip: number;
  readonly netmask: number;
  readonly arpTable = new Map<number, number[]>();
  /** Echo requests answered. */
  echoes = 0;
  /** Frames this host got (for it or broadcast) and sent. */
  received = 0;
  sent = 0;
  readonly clock: LanClock;
  private readonly lan: VirtualLan;
  private readonly udpPorts = new Map<number, UdpHandler>();
  private readonly waiting = new Map<number, Uint8Array[]>();
  private readonly listeners = new Map<number, (connection: TcpConnection) => void>();
  private readonly tcp = new Map<string, TcpConnection>();
  private nextId = 1;
  private nextPort = 49152;
  private iss: number;

  constructor(lan: VirtualLan, options: { mac: Mac; ip: number; netmask: number }) {
    this.lan = lan;
    this.clock = lan.clock;
    this.mac = options.mac;
    this.ip = options.ip >>> 0;
    this.netmask = options.netmask >>> 0;
    this.iss = Math.imul(this.ip, 2654435761) >>> 0;
  }

  /** A bench reset: no connections, nothing learned, nothing waiting. */
  reset(): void {
    this.tcp.clear();
    this.arpTable.clear();
    this.waiting.clear();
  }

  /** Open TCP connections. */
  get connections(): number {
    return this.tcp.size;
  }

  /** Accepts connections on `port` (the callback sets the connection's handlers). */
  listenTcp(port: number, accept: (connection: TcpConnection) => void): void {
    this.listeners.set(port, accept);
  }

  /** Opens a connection to `ip`:`port` from an ephemeral port; set its handlers before the bench runs on. */
  connectTcp(ip: number, port: number): TcpConnection {
    let local = this.nextPort;
    for (let i = 0; i < 16384 && this.tcp.has(key(ip, port, local)); i++) local = 49152 + ((local - 49152 + 1) % 16384);
    this.nextPort = 49152 + ((local - 49152 + 1) % 16384);
    const connection = new TcpConnection(this, local, ip, port, this.nextIss(), 'syn-sent');
    this.tcp.set(key(ip, port, local), connection);
    connection.open();
    return connection;
  }

  output(remoteIp: number, segment: Uint8Array): void {
    this.sendIp(remoteIp, PROTO_TCP, segment);
  }

  forget(connection: TcpConnection): void {
    const k = key(connection.remoteIp, connection.remotePort, connection.localPort);
    if (this.tcp.get(k) === connection) this.tcp.delete(k);
  }

  private nextIss(): number {
    this.iss = (this.iss + 64000) >>> 0;
    return this.iss;
  }

  private tcpIn(src: number, srcMac: number[], payload: Uint8Array, dst: number): void {
    const seg = parseTcp(src, dst, payload);
    if (seg === undefined) return;
    const existing = this.tcp.get(key(src, seg.srcPort, seg.dstPort));
    if (existing !== undefined) {
      existing.segment(seg);
      return;
    }
    const accept = this.listeners.get(seg.dstPort);
    if ((seg.flags & (TCP.SYN | TCP.ACK | TCP.RST)) === TCP.SYN && accept !== undefined) {
      const connection = new TcpConnection(this, seg.dstPort, src, seg.srcPort, this.nextIss(), 'syn-received');
      this.tcp.set(key(src, seg.srcPort, seg.dstPort), connection);
      accept(connection);
      connection.accept(seg);
      return;
    }
    if ((seg.flags & TCP.RST) !== 0) return;
    // No such connection: reset (RFC 9293 §3.10.7.1).
    const length = seg.data.length + ((seg.flags & TCP.SYN) !== 0 ? 1 : 0) + ((seg.flags & TCP.FIN) !== 0 ? 1 : 0);
    const reply =
      (seg.flags & TCP.ACK) !== 0
        ? tcpSegment(this.ip, src, { srcPort: seg.dstPort, dstPort: seg.srcPort, seq: seg.ack, ack: 0, flags: TCP.RST, window: 0 })
        : tcpSegment(this.ip, src, { srcPort: seg.dstPort, dstPort: seg.srcPort, seq: 0, ack: (seg.seq + length) >>> 0, flags: TCP.RST | TCP.ACK, window: 0 });
    this.sendIp(src, PROTO_TCP, reply, srcMac);
  }

  bindUdp(port: number, handler: UdpHandler): void {
    this.udpPorts.set(port, handler);
  }

  /** The subnet's broadcast address. */
  get subnetBroadcast(): number {
    return ((this.ip & this.netmask) | ~this.netmask) >>> 0;
  }

  deliver(frame: Uint8Array): void {
    const eth = parseEthernet(frame);
    if (eth === undefined) return;
    this.received++;
    if (eth.type === ETHERTYPE_ARP) {
      const packet = parseArp(eth.payload);
      if (packet === undefined) return;
      if (packet.senderIp !== 0) this.learn(packet.senderIp, packet.senderMac);
      if (packet.op === ARP_REQUEST && packet.targetIp === this.ip) {
        this.send(packet.senderMac, ETHERTYPE_ARP, arp({ op: ARP_REPLY, senderMac: [...this.mac], senderIp: this.ip, targetMac: packet.senderMac, targetIp: packet.senderIp }));
      }
      return;
    }
    if (eth.type !== ETHERTYPE_IPV4) return;
    const packet = parseIpv4(eth.payload);
    if (packet === undefined) return;
    const forUs = packet.dst === this.ip || packet.dst === BROADCAST_IP || packet.dst === this.subnetBroadcast;
    if (!forUs) return;
    if (packet.src !== 0 && (packet.src & this.netmask) === (this.ip & this.netmask)) this.learn(packet.src, eth.src);
    if (packet.protocol === PROTO_ICMP) {
      if (packet.payload[0] !== ICMP_ECHO_REQUEST || packet.dst !== this.ip) return;
      const reply = icmpEchoReply(packet.payload);
      if (reply === undefined) return;
      this.echoes++;
      this.sendIp(packet.src, PROTO_ICMP, reply, eth.src);
      return;
    }
    if (packet.protocol === PROTO_TCP) {
      if (packet.dst === this.ip) this.tcpIn(packet.src, eth.src, packet.payload, packet.dst);
      return;
    }
    if (packet.protocol === PROTO_UDP) {
      const datagram = parseUdp(packet.src, packet.dst, packet.payload);
      if (datagram === undefined) return;
      this.udpPorts.get(datagram.dstPort)?.({ ip: packet.src, port: datagram.srcPort, mac: eth.src }, datagram.data);
    }
  }

  /** A UDP datagram to `dst`:`dstPort`; `dstMac` skips ARP (a reply to a known sender, a broadcast). */
  sendUdp(dst: number, srcPort: number, dstPort: number, data: Uint8Array, dstMac?: Mac): void {
    this.sendIp(dst, PROTO_UDP, udp(this.ip, dst, srcPort, dstPort, data), dstMac);
  }

  sendIp(dst: number, protocol: number, payload: Uint8Array, dstMac?: Mac): void {
    const packet = ipv4({ protocol, src: this.ip, dst, payload, id: this.nextId++ & 0xffff });
    const mac = dst === BROADCAST_IP || dst === this.subnetBroadcast ? BROADCAST_MAC : (dstMac ?? this.arpTable.get(dst));
    if (mac !== undefined) {
      this.send(mac, ETHERTYPE_IPV4, packet);
      return;
    }
    let queue = this.waiting.get(dst);
    if (queue === undefined) {
      this.waiting.set(dst, (queue = []));
      this.send(BROADCAST_MAC, ETHERTYPE_ARP, arp({ op: ARP_REQUEST, senderMac: [...this.mac], senderIp: this.ip, targetMac: [0, 0, 0, 0, 0, 0], targetIp: dst }));
    }
    if (queue.length < ARP_QUEUE) queue.push(packet);
  }

  private learn(ip: number, mac: number[]): void {
    this.arpTable.set(ip, mac);
    const queue = this.waiting.get(ip);
    if (queue === undefined) return;
    this.waiting.delete(ip);
    for (const packet of queue) this.send(mac, ETHERTYPE_IPV4, packet);
  }

  private send(dst: Mac, type: number, payload: Uint8Array): void {
    this.sent++;
    this.lan.send(this, ethernet(dst, this.mac, type, payload));
  }
}

function key(ip: number, port: number, local: number): string {
  return `${ip >>> 0}:${port}:${local}`;
}
