/**
 * The access point's DHCP server (BT98; RFC 2131/2132): a client's first DISCOVER takes the next
 * free address of the pool (192.168.4.2 on) and keeps it for the bench's life, as a home router's
 * lease table would; REQUEST for it is ACKed (with the subnet mask, router, DNS server, lease and
 * renewal times), for anything else NAKed; RELEASE frees it; DECLINE marks it taken (the client's
 * ARP check found it in use); INFORM gets the options. Replies are broadcast — RFC 2131 allows
 * it, and every client accepts it — except to a client that already has its address (ciaddr),
 * which gets them unicast.
 *
 * BT115: `DhcpClient`, for the runtime's own hosts on a LAN whose DHCP server is a board's (a soft
 * access point): DISCOVER, the first OFFER, REQUEST for it, ACK — the host takes the address, mask
 * and router (`IpHost.configure`). Everything is broadcast with the broadcast flag set, as from a
 * client without an address; a DISCOVER or REQUEST unanswered after RETRY_MS goes again; a NAK
 * starts over. Leases aren't renewed (the bench's runs are shorter than any lease).
 */

import type { IpHost } from './host.ts';
import { BROADCAST_IP, BROADCAST_MAC, be16, be32, ipString, type Mac, macAt, macString, setBe16, setBe32 } from './packet.ts';

export const DHCP_SERVER_PORT = 67;
export const DHCP_CLIENT_PORT = 68;
const MAGIC = 0x63825363;
const FIXED = 240;

export const DHCP = { DISCOVER: 1, OFFER: 2, REQUEST: 3, DECLINE: 4, ACK: 5, NAK: 6, RELEASE: 7, INFORM: 8 } as const;

export interface DhcpConfig {
  server: number;
  netmask: number;
  router: number;
  dns: number;
  /** The pool, inclusive. */
  first: number;
  last: number;
  leaseSeconds: number;
}

/** A client message's fields the server uses. */
export interface DhcpMessage {
  type: number;
  xid: number;
  flags: number;
  ciaddr: number;
  giaddr: number;
  chaddr: number[];
  requested: number;
  serverId: number;
  hostname: string;
}

/** A BOOTREQUEST, or undefined. */
export function parseDhcp(p: Uint8Array): DhcpMessage | undefined {
  if (p.length < FIXED + 4 || p[0] !== 1 || p[1] !== 1 || p[2] !== 6 || be32(p, 236) !== MAGIC) return undefined;
  const message: DhcpMessage = { type: 0, xid: be32(p, 4), flags: be16(p, 10), ciaddr: be32(p, 12), giaddr: be32(p, 24), chaddr: macAt(p, 28), requested: 0, serverId: 0, hostname: '' };
  for (let i = FIXED; i < p.length; ) {
    const code = p[i];
    if (code === 255) break;
    if (code === 0) {
      i++;
      continue;
    }
    if (i + 1 >= p.length) return undefined;
    const length = p[i + 1];
    const at = i + 2;
    if (at + length > p.length) return undefined;
    if (code === 53 && length >= 1) message.type = p[at];
    else if (code === 50 && length >= 4) message.requested = be32(p, at);
    else if (code === 54 && length >= 4) message.serverId = be32(p, at);
    else if (code === 12) message.hostname = String.fromCharCode(...p.subarray(at, at + length));
    i = at + length;
  }
  return message.type === 0 ? undefined : message;
}

/** Where a reply goes: broadcast (IP and MAC), or unicast to `ip` at the client's MAC. */
export interface DhcpReply {
  data: Uint8Array;
  broadcast: boolean;
  ip: number;
  mac: Mac;
}

export class DhcpServer {
  readonly config: DhcpConfig;
  /** Client MAC (aa:bb:…) → its address. */
  readonly leases = new Map<string, number>();
  /** Client MAC → the hostname it sent (option 12), for the AP's view. */
  readonly hostnames = new Map<string, string>();
  private readonly declined = new Set<number>();
  /** Addresses in the pool that hosts hold already (the server parts'). */
  readonly reserved = new Set<number>();
  /** BT100: runs when a REQUEST is acknowledged (the client MAC, its address). */
  onack: ((mac: string, ip: number) => void) | null = null;

  constructor(config: DhcpConfig) {
    this.config = config;
  }

  /** The address `mac` holds, or undefined. */
  leaseOf(mac: Mac): number | undefined {
    return this.leases.get(macString(mac));
  }

  handle(p: Uint8Array): DhcpReply | undefined {
    const m = parseDhcp(p);
    if (m === undefined) return undefined;
    const key = macString(m.chaddr);
    if (m.hostname !== '') this.hostnames.set(key, m.hostname);
    const c = this.config;
    switch (m.type) {
      case DHCP.DISCOVER: {
        const ip = this.allocate(key);
        return ip === undefined ? undefined : this.reply(m, DHCP.OFFER, ip);
      }
      case DHCP.REQUEST: {
        if (m.serverId !== 0 && m.serverId !== c.server) {
          this.leases.delete(key); // the client chose another server
          return undefined;
        }
        const wanted = m.requested !== 0 ? m.requested : m.ciaddr;
        const ip = this.leases.get(key) ?? (wanted !== 0 && this.free(wanted) ? wanted : undefined);
        if (ip === undefined || ip !== wanted) return this.reply(m, DHCP.NAK, 0);
        this.leases.set(key, ip);
        const reply = this.reply(m, DHCP.ACK, ip);
        this.onack?.(key, ip);
        return reply;
      }
      case DHCP.DECLINE:
        if (m.requested !== 0) this.declined.add(m.requested);
        this.leases.delete(key);
        return undefined;
      case DHCP.RELEASE:
        this.leases.delete(key);
        return undefined;
      case DHCP.INFORM:
        return this.reply(m, DHCP.ACK, 0);
      default:
        return undefined;
    }
  }

  private free(ip: number): boolean {
    const c = this.config;
    if (ip < c.first || ip > c.last || this.declined.has(ip) || this.reserved.has(ip)) return false;
    for (const used of this.leases.values()) if (used === ip) return false;
    return true;
  }

  private allocate(key: string): number | undefined {
    const held = this.leases.get(key);
    if (held !== undefined) return held;
    for (let ip = this.config.first; ip <= this.config.last; ip++) {
      if (this.free(ip)) {
        this.leases.set(key, ip);
        return ip;
      }
    }
    return undefined;
  }

  private reply(m: DhcpMessage, type: number, yiaddr: number): DhcpReply {
    const c = this.config;
    const options: number[] = [53, 1, type, 54, 4, ...bytes(c.server)];
    if (type !== DHCP.NAK) {
      if (yiaddr !== 0) options.push(51, 4, ...bytes(c.leaseSeconds), 58, 4, ...bytes(c.leaseSeconds >>> 1), 59, 4, ...bytes(Math.floor((c.leaseSeconds * 7) / 8)));
      options.push(1, 4, ...bytes(c.netmask), 3, 4, ...bytes(c.router), 6, 4, ...bytes(c.dns));
    }
    options.push(255);
    const p = new Uint8Array(FIXED + options.length + ((4 - ((FIXED + options.length) % 4)) % 4));
    p[0] = 2;
    p[1] = 1;
    p[2] = 6;
    setBe32(p, 4, m.xid);
    setBe16(p, 10, m.flags);
    if (type === DHCP.ACK && yiaddr === 0) setBe32(p, 12, m.ciaddr); // INFORM
    setBe32(p, 16, yiaddr);
    setBe32(p, 24, m.giaddr);
    p.set(m.chaddr, 28);
    setBe32(p, 236, MAGIC);
    p.set(options, FIXED);
    const unicast = type !== DHCP.NAK && m.ciaddr !== 0;
    return { data: p, broadcast: !unicast, ip: unicast ? m.ciaddr : 0xffffffff, mac: m.chaddr };
  }
}

function bytes(v: number): number[] {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}

/** "192.168.4.2 (esp32-0a1b2c)" for a lease, as the AP's view lists it. */
export function leaseText(ip: number, hostname: string | undefined): string {
  return hostname === undefined || hostname === '' ? ipString(ip) : `${ipString(ip)} (${hostname})`;
}

/** A server's reply's fields the client uses (BOOTREPLY). */
export interface DhcpReplyMessage {
  type: number;
  xid: number;
  yiaddr: number;
  chaddr: number[];
  serverId: number;
  netmask: number;
  router: number;
  dns: number;
  leaseSeconds: number;
}

/** A BOOTREPLY, or undefined. */
export function parseDhcpReply(p: Uint8Array): DhcpReplyMessage | undefined {
  if (p.length < FIXED + 4 || p[0] !== 2 || p[1] !== 1 || p[2] !== 6 || be32(p, 236) !== MAGIC) return undefined;
  const m: DhcpReplyMessage = { type: 0, xid: be32(p, 4), yiaddr: be32(p, 16), chaddr: macAt(p, 28), serverId: 0, netmask: 0, router: 0, dns: 0, leaseSeconds: 0 };
  for (let i = FIXED; i < p.length; ) {
    const code = p[i];
    if (code === 255) break;
    if (code === 0) {
      i++;
      continue;
    }
    if (i + 1 >= p.length) return undefined;
    const length = p[i + 1];
    const at = i + 2;
    if (at + length > p.length) return undefined;
    if (code === 53 && length >= 1) m.type = p[at];
    else if (code === 54 && length >= 4) m.serverId = be32(p, at);
    else if (code === 1 && length >= 4) m.netmask = be32(p, at);
    else if (code === 3 && length >= 4) m.router = be32(p, at);
    else if (code === 6 && length >= 4) m.dns = be32(p, at);
    else if (code === 51 && length >= 4) m.leaseSeconds = be32(p, at);
    i = at + length;
  }
  return m.type === 0 ? undefined : m;
}

/** A client message (BOOTREQUEST): DISCOVER, or REQUEST for `requested` from `server`. */
export function dhcpRequestMessage(type: number, xid: number, mac: Mac, hostname: string, requested = 0, server = 0): Uint8Array {
  const options: number[] = [53, 1, type, 55, 3, 1, 3, 6];
  if (requested !== 0) options.push(50, 4, ...bytes(requested));
  if (server !== 0) options.push(54, 4, ...bytes(server));
  const name = [...hostname].slice(0, 32).map((c) => c.charCodeAt(0) & 0x7f);
  if (name.length > 0) options.push(12, name.length, ...name);
  options.push(255);
  const p = new Uint8Array(FIXED + options.length + ((4 - ((FIXED + options.length) % 4)) % 4));
  p[0] = 1;
  p[1] = 1;
  p[2] = 6;
  setBe32(p, 4, xid);
  setBe16(p, 10, 0x8000); // broadcast: the client has no address to take a unicast reply
  p.set(mac, 28);
  setBe32(p, 236, MAGIC);
  p.set(options, FIXED);
  return p;
}

/** A DISCOVER or REQUEST unanswered after this goes again, ms. */
export const DHCP_RETRY_MS = 1000;

/** What a DHCP client got: its address, the mask, router and DNS server, from `server`. */
export interface DhcpLease {
  ip: number;
  netmask: number;
  router: number;
  dns: number;
  server: number;
}

/** A DHCP client for an IpHost without an address (BT115). */
export class DhcpClient {
  private readonly host: IpHost;
  private readonly hostname: string;
  private readonly onBound: (lease: DhcpLease) => void;
  private xid: number;
  /** 'idle' until start; then discovering, requesting, bound — or stopped. */
  state: 'idle' | 'discovering' | 'requesting' | 'bound' | 'stopped' = 'idle';
  lease: DhcpLease | null = null;
  private offered = 0;
  private server = 0;
  private generation = 0;

  constructor(host: IpHost, hostname: string, onBound: (lease: DhcpLease) => void) {
    this.host = host;
    this.hostname = hostname;
    this.onBound = onBound;
    this.xid = (Math.imul(host.mac[3] << 16 | host.mac[4] << 8 | host.mac[5], 2654435761) ^ 0x5eed) >>> 0;
    host.bindUdp(DHCP_CLIENT_PORT, (_from, data) => this.reply(data));
  }

  /** Asks for an address (DISCOVER), and again until it has one. */
  start(): void {
    this.lease = null;
    this.host.configure(0, 0, 0);
    this.discover();
  }

  /** No more messages; the host keeps whatever address it has. */
  stop(): void {
    this.state = 'stopped';
    this.generation++;
  }

  private discover(): void {
    this.state = 'discovering';
    this.xid = (this.xid + 1) >>> 0;
    this.send(dhcpRequestMessage(DHCP.DISCOVER, this.xid, this.host.mac, this.hostname));
    this.retry('discovering', () => this.discover());
  }

  private request(): void {
    this.state = 'requesting';
    this.send(dhcpRequestMessage(DHCP.REQUEST, this.xid, this.host.mac, this.hostname, this.offered, this.server));
    this.retry('requesting', () => this.request());
  }

  private retry(state: DhcpClient['state'], again: () => void): void {
    const generation = ++this.generation;
    const clock = this.host.clock;
    clock.schedule(clock.now() + DHCP_RETRY_MS * 1e6, () => {
      if (generation === this.generation && this.state === state) again();
    });
  }

  private send(message: Uint8Array): void {
    this.host.sendUdp(BROADCAST_IP, DHCP_CLIENT_PORT, DHCP_SERVER_PORT, message, BROADCAST_MAC);
  }

  private reply(data: Uint8Array): void {
    const m = parseDhcpReply(data);
    if (m === undefined || m.xid !== this.xid || !m.chaddr.every((b, i) => b === this.host.mac[i])) return;
    if (this.state === 'discovering' && m.type === DHCP.OFFER && m.yiaddr !== 0) {
      this.offered = m.yiaddr;
      this.server = m.serverId;
      this.request();
    } else if (this.state === 'requesting' && m.type === DHCP.ACK && m.yiaddr === this.offered) {
      this.generation++;
      this.state = 'bound';
      const lease: DhcpLease = { ip: m.yiaddr, netmask: m.netmask || 0xffffff00, router: m.router, dns: m.dns, server: m.serverId };
      this.lease = lease;
      this.host.configure(lease.ip, lease.netmask, lease.router);
      this.onBound(lease);
    } else if (this.state === 'requesting' && m.type === DHCP.NAK) this.discover();
  }
}
