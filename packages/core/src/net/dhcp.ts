/**
 * The access point's DHCP server (BT98; RFC 2131/2132): a client's first DISCOVER takes the next
 * free address of the pool (192.168.4.2 on) and keeps it for the bench's life, as a home router's
 * lease table would; REQUEST for it is ACKed (with the subnet mask, router, DNS server, lease and
 * renewal times), for anything else NAKed; RELEASE frees it; DECLINE marks it taken (the client's
 * ARP check found it in use); INFORM gets the options. Replies are broadcast — RFC 2131 allows
 * it, and every client accepts it — except to a client that already has its address (ciaddr),
 * which gets them unicast.
 */

import { be16, be32, ipString, type Mac, macAt, macString, setBe16, setBe32 } from './packet.ts';

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
