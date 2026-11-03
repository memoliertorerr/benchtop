/**
 * The bench's virtual network (BT98). Every part whose `netSpecFor` role is an access point gets
 * a LAN of its own (lan.ts) with the AP's gateway on it: an IpHost at 192.168.4.1/24 whose MAC is
 * the AP's BSSID (derived from the part id, so it survives rebuilds), with the DHCP server
 * (pool .2–.254, 2-hour leases; DNS points at the gateway). Boards with WiFi get `radio`: the APs
 * that are on, and `join` to put a station on one's LAN. An AP switched off (`set:on=0`, or a
 * release) drops its stations, each told through its `lost`; on again (`set:on=1`, a press) it
 * is back with its leases. `set:rssi=<dBm>` changes the signal the next scan reports. Each AP shows `{ on, ssid, stations, clients }` — the clients one a
 * line, as "192.168.4.2 (hostname)" by lease, or the MAC while a station has none.
 */

import type { PartInput, PartProps, Problem, VisualState } from '../contracts/part.ts';
import { DHCP_CLIENT_PORT, DHCP_SERVER_PORT, DhcpServer, leaseText } from './dhcp.ts';
import { DNS_PORT, dnsName, DnsServer } from './dns.ts';
import { IpHost } from './host.ts';
import { HttpServer, parseRoutes } from './http.ts';
import { type LanClock, type LanPort, VirtualLan } from './lan.ts';
import { BROADCAST_IP, BROADCAST_MAC, ipString, type Mac, macFromName, macString } from './packet.ts';
import type { AccessPointInfo, WifiLink, WifiRadio } from './radio.ts';
import type { AccessPointRole, HttpServerRole, NetSpecFor } from './spec.ts';

export const GATEWAY_IP = 0xc0a80401; // 192.168.4.1
export const NETMASK = 0xffffff00;
const POOL_FIRST = 0xc0a80402;
const POOL_LAST = 0xc0a804fe;
const LEASE_SECONDS = 7200;
/** Server parts without an address take the next free one from here. */
const SERVERS_FIRST = 0xc0a8040a;
const LOG_LINES = 5;

interface Station {
  port: LanPort;
  lost: () => void;
}

/** One access point: its LAN, gateway and stations. */
export class AccessPoint {
  readonly id: string;
  readonly role: AccessPointRole;
  readonly bssid: number[];
  readonly lan: VirtualLan;
  readonly gateway: IpHost;
  readonly dhcp: DhcpServer;
  readonly dns: DnsServer;
  /** The server parts on this LAN (BT99). */
  readonly servers: ServerHost[] = [];
  on: boolean;
  /** dBm; `set:rssi=<v>` changes it while running (what the next scan sees). */
  rssi: number;
  readonly stations = new Map<string, Station>();
  /** The last visual state's key (collect sends only changes). */
  shown = '';

  constructor(id: string, role: AccessPointRole, clock: LanClock) {
    this.id = id;
    this.role = role;
    this.on = role.on;
    this.rssi = role.rssi;
    this.bssid = macFromName(`wifi-ap:${id}`);
    this.lan = new VirtualLan(clock);
    this.gateway = new IpHost(this.lan, { mac: this.bssid, ip: GATEWAY_IP, netmask: NETMASK });
    this.lan.attach(this.gateway, false);
    this.dhcp = new DhcpServer({ server: GATEWAY_IP, netmask: NETMASK, router: GATEWAY_IP, dns: GATEWAY_IP, first: POOL_FIRST, last: POOL_LAST, leaseSeconds: LEASE_SECONDS });
    this.gateway.bindUdp(DHCP_SERVER_PORT, (_from, data) => {
      const reply = this.dhcp.handle(data);
      if (reply === undefined) return;
      this.gateway.sendUdp(reply.broadcast ? BROADCAST_IP : reply.ip, DHCP_SERVER_PORT, DHCP_CLIENT_PORT, reply.data, reply.broadcast ? BROADCAST_MAC : reply.mac);
    });
    this.dns = new DnsServer((name) => this.resolve(name));
    this.gateway.bindUdp(DNS_PORT, (from, data) => {
      const reply = this.dns.handle(data);
      if (reply !== undefined) this.gateway.sendUdp(from.ip, DNS_PORT, from.port, reply, from.mac);
    });
  }

  /**
   * A name on this LAN: a server's hostname, a station's DHCP hostname (its lease), or "gateway"
   * (the router itself) — without case.
   */
  resolve(name: string): number | undefined {
    const n = dnsName(name);
    if (n === 'gateway') return GATEWAY_IP;
    for (const server of this.servers) if (server.role.hostname !== '' && dnsName(server.role.hostname) === n) return server.host.ip;
    for (const [mac, hostname] of this.dhcp.hostnames) {
      if (dnsName(hostname) !== n) continue;
      const ip = this.dhcp.leases.get(mac);
      if (ip !== undefined) return ip;
    }
    return undefined;
  }

  info(): AccessPointInfo {
    const r = this.role;
    return { ssid: r.ssid, bssid: this.bssid, channel: r.channel, rssi: this.rssi, security: r.security, password: r.password, hidden: r.hidden };
  }

  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (on) return;
    const dropped = [...this.stations.values()];
    this.stations.clear();
    for (const station of dropped) {
      this.lan.detach(station.port);
      station.lost();
    }
  }

  visual(): VisualState {
    const clients = [...this.stations.keys()].map((mac) => {
      const ip = this.dhcp.leases.get(mac);
      return ip === undefined ? mac : leaseText(ip, this.dhcp.hostnames.get(mac));
    });
    return { on: this.on, ssid: this.role.ssid, stations: this.stations.size, clients: clients.join('\n') };
  }
}

/** A server part (BT99): its host on an AP's LAN and the HTTP server on it. */
export class ServerHost {
  readonly id: string;
  readonly role: HttpServerRole;
  readonly host: IpHost;
  readonly http: HttpServer;
  shown = '';

  constructor(id: string, role: HttpServerRole, ap: AccessPoint, ip: number) {
    this.id = id;
    this.role = role;
    this.host = new IpHost(ap.lan, { mac: macFromName(`http-server:${id}`), ip, netmask: NETMASK });
    ap.lan.attach(this.host, false);
    this.http = new HttpServer(this.host, role.port, parseRoutes(role.routes).routes);
  }

  visual(): VisualState {
    const lines = this.http.log.slice(-LOG_LINES).map((e) => `${e.method} ${e.path} → ${e.status}`);
    return { address: `${ipString(this.host.ip)}:${this.role.port}`, hostname: this.role.hostname, requests: this.http.count, log: lines.join('\n') };
  }
}

export class NetRuntime {
  readonly radio: WifiRadio;
  private readonly aps: AccessPoint[];
  private readonly servers: ServerHost[];
  private readonly buildProblems: Problem[];

  private constructor(aps: AccessPoint[], servers: ServerHost[], problems: Problem[]) {
    this.aps = aps;
    this.servers = servers;
    this.buildProblems = problems;
    this.radio = {
      accessPoints: () => this.aps.filter((ap) => ap.on).map((ap) => ap.info()),
      join: (bssid, mac, receive, lost) => this.join(bssid, mac, receive, lost),
    };
  }

  /**
   * The network of `parts` (an AP per access-point role). BT78: a rebuild passes the previous
   * bench's network: an AP with the same part id keeps its leases (the stations of kept boards
   * keep their addresses) and its on/off state.
   */
  static build(parts: readonly { id: string; type: string; props: PartProps }[], netSpecFor: NetSpecFor, clock: LanClock, previous: NetRuntime | null = null): NetRuntime {
    const aps: AccessPoint[] = [];
    for (const part of parts) {
      const role = netSpecFor(part.type, part.props);
      if (role?.kind !== 'access-point') continue;
      const ap = new AccessPoint(part.id, role, clock);
      const old = previous?.aps.find((a) => a.id === part.id);
      if (old !== undefined) {
        ap.on = old.on;
        ap.rssi = old.rssi;
        for (const [mac, ip] of old.dhcp.leases) ap.dhcp.leases.set(mac, ip);
        for (const [mac, name] of old.dhcp.hostnames) ap.dhcp.hostnames.set(mac, name);
      }
      aps.push(ap);
    }
    // Server parts (BT99), on their AP's LAN: those asking for an address first, so an automatic
    // one never takes it.
    const servers: ServerHost[] = [];
    const problems: Problem[] = [];
    const asked: { id: string; role: HttpServerRole }[] = [];
    for (const part of parts) {
      const role = netSpecFor(part.type, part.props);
      if (role?.kind === 'http-server') asked.push({ id: part.id, role });
    }
    asked.sort((a, b) => (a.role.address === 0 ? 1 : 0) - (b.role.address === 0 ? 1 : 0));
    for (const part of asked) {
      const role = part.role;
      const ap = role.network === '' ? aps[0] : aps.find((a) => a.role.ssid === role.network);
      if (ap === undefined) {
        problems.push({ severity: 'warning', code: 'net-no-access-point', message: role.network === '' ? `${part.id} needs a WiFi access point on the bench: it sits on its network.` : `${part.id} sits on the network "${role.network}", and no access point has that SSID.`, parts: [part.id] });
        continue;
      }
      const taken = (ip: number): boolean => ip === GATEWAY_IP || ap.servers.some((s) => s.host.ip === ip);
      let ip = role.address;
      if (ip !== 0 && ((ip & NETMASK) !== (GATEWAY_IP & NETMASK) || taken(ip) || (ip & 0xff) === 0 || (ip & 0xff) === 0xff)) {
        problems.push({ severity: 'warning', code: 'net-bad-address', message: `${part.id}'s address ${ipString(ip)} isn't free on 192.168.4.0/24: it takes the next free one.`, parts: [part.id] });
        ip = 0;
      }
      if (ip === 0) for (ip = SERVERS_FIRST; taken(ip); ip++);
      const server = new ServerHost(part.id, role, ap, ip);
      ap.servers.push(server);
      ap.dhcp.reserved.add(ip);
      servers.push(server);
      const { errors } = parseRoutes(role.routes);
      if (errors.length > 0) problems.push({ severity: 'warning', code: 'http-routes', message: `${part.id}'s routes skip ${errors.length === 1 ? 'a line' : `${errors.length} lines`}: ${errors.slice(0, 3).join('; ')}`, parts: [part.id] });
    }
    // In document order (the views and tools list them so).
    const order = new Map(parts.map((p, i) => [p.id, i]));
    servers.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return new NetRuntime(aps, servers, problems);
  }

  /** What the build found wrong (a server without its AP, a bad address, route lines skipped). */
  problems(): readonly Problem[] {
    return this.buildProblems;
  }

  get serverHosts(): readonly ServerHost[] {
    return this.servers;
  }

  /** A bench reset: every AP as the document has it, no stations, no leases. */
  reset(): void {
    for (const ap of this.aps) {
      for (const station of ap.stations.values()) ap.lan.detach(station.port);
      ap.stations.clear();
      ap.dhcp.leases.clear();
      ap.dhcp.hostnames.clear();
      ap.gateway.reset();
      ap.on = ap.role.on;
      ap.rssi = ap.role.rssi;
      ap.shown = '';
    }
    for (const server of this.servers) {
      server.host.reset();
      server.http.log.length = 0;
      server.http.count = 0;
      server.shown = '';
    }
  }

  /** This bench is done (a rebuild took over): frames still in the air reach nobody. */
  dispose(): void {
    for (const ap of this.aps) {
      for (const station of ap.stations.values()) ap.lan.detach(station.port);
      ap.stations.clear();
      ap.lan.detach(ap.gateway);
      for (const server of ap.servers) ap.lan.detach(server.host);
    }
  }

  get accessPoints(): readonly AccessPoint[] {
    return this.aps;
  }

  owns(partId: string): boolean {
    return this.aps.some((ap) => ap.id === partId) || this.servers.some((s) => s.id === partId);
  }

  /** `set:on=0|1` and `set:rssi=<dBm>` (key down), press (on) and release (off). */
  input(partId: string, event: PartInput): void {
    const ap = this.aps.find((a) => a.id === partId);
    if (ap === undefined) return;
    if (event.kind === 'press') ap.setOn(true);
    else if (event.kind === 'release') ap.setOn(false);
    else if (event.kind === 'key' && event.down) {
      const on = /^set:on=([01])$/.exec(event.key);
      if (on !== null) ap.setOn(on[1] === '1');
      const rssi = /^set:rssi=(-?\d+(?:\.\d+)?)$/.exec(event.key);
      if (rssi !== null) ap.rssi = Math.min(-20, Math.max(-100, Math.round(Number(rssi[1]))));
    }
  }

  /** Visual states of the APs that changed since the last call. */
  collect(out: [string, VisualState][]): void {
    for (const ap of this.aps) {
      const state = ap.visual();
      const key = JSON.stringify(state);
      if (key === ap.shown) continue;
      ap.shown = key;
      out.push([ap.id, state]);
    }
    for (const server of this.servers) {
      const state = server.visual();
      const key = JSON.stringify(state);
      if (key === server.shown) continue;
      server.shown = key;
      out.push([server.id, state]);
    }
  }

  /** Every AP's state now (a rebuilt or reset bench shows them once). */
  invalidate(): void {
    for (const ap of this.aps) ap.shown = '';
    for (const server of this.servers) server.shown = '';
  }

  private join(bssid: Mac, mac: Mac, receive: (frame: Uint8Array) => void, lost: () => void): WifiLink | undefined {
    const ap = this.aps.find((a) => a.on && a.bssid.every((b, i) => b === bssid[i]));
    if (ap === undefined) return undefined;
    const key = macString(mac);
    const previous = ap.stations.get(key);
    if (previous !== undefined) ap.lan.detach(previous.port);
    const port: LanPort = { mac: [...mac], deliver: receive };
    ap.lan.attach(port, true);
    ap.stations.set(key, { port, lost });
    return {
      send: (frame) => ap.lan.send(port, frame),
      leave: () => {
        ap.lan.detach(port);
        if (ap.stations.get(key)?.port === port) ap.stations.delete(key);
      },
    };
  }
}
