/**
 * The bench's virtual network (BT98). Every part whose `netSpecFor` role is an access point gets
 * a LAN of its own (lan.ts) with the AP's gateway on it: an IpHost at 192.168.4.1/24 whose MAC is
 * the AP's BSSID (derived from the part id, so it survives rebuilds), with the DHCP server
 * (pool .2–.254, 2-hour leases; DNS points at the gateway). Boards with WiFi get a radio
 * (`radioFor(board)`): the APs that are on, and `join` to put the board's station on one's LAN.
 * An AP switched off (`set:on=0`, or a release) drops its stations, each told through its `lost`;
 * on again (`set:on=1`, a press) it is back with its leases. `set:rssi=<dBm>` changes the signal
 * the next scan reports. Each AP shows `{ on, ssid, stations, clients }` — the clients one a
 * line, as "192.168.4.2 (hostname)" by lease, or the MAC while a station has none.
 *
 * BT99: server parts (an HTTP server) are hosts on an AP's LAN. BT100: client parts (an HTTP
 * client: a request when pressed, or every `interval` ms) too; `request` sends one from an AP's
 * gateway (the MCP server's `sim_http`); `listen` reports what happens — a board connected (its
 * DHCP lease acknowledged) or gone, a server part's answer, a client part's response — for spec
 * assertions; `stations()` lists who is on which LAN.
 *
 * BT101: an AP with `internet` on lets its stations reach the hosts its `allow` list names
 * through the host's `Uplink` (net/uplink.ts): the gateway's DNS gives each allowed name an
 * address from 198.18.0.0/15, and the gateway takes TCP to those addresses (and to allowed IPv4
 * addresses) as a transparent proxy, opening the real connection first. What the uplink refuses
 * or loses shows as a `net-internet` problem on the AP; the AP's view says how many connections
 * are out.
 */

import type { PartInput, PartProps, Problem, VisualState } from '../contracts/part.ts';
import { DHCP_CLIENT_PORT, DHCP_SERVER_PORT, DhcpServer, leaseText } from './dhcp.ts';
import { DNS_PORT, dnsName, DnsServer } from './dns.ts';
import { IpHost, type OutsideTcp } from './host.ts';
import { httpRequest, type HttpResult, HttpServer, parseHttpUrl, parseRoutes, utf8Bytes, utf8String } from './http.ts';
import { type LanClock, type LanPort, VirtualLan } from './lan.ts';
import { type AllowEntry, allows, OUTSIDE_FIRST, parseAllowList, type Uplink, type UplinkSocket } from './uplink.ts';
import { BROADCAST_IP, BROADCAST_MAC, ipString, type Mac, macFromName, macString, parseIp } from './packet.ts';
import type { TcpConnection } from './tcp.ts';
import type { AccessPointInfo, WifiLink, WifiRadio } from './radio.ts';
import type { AccessPointRole, HttpClientRole, HttpServerRole, NetSpecFor } from './spec.ts';

export const GATEWAY_IP = 0xc0a80401; // 192.168.4.1
export const NETMASK = 0xffffff00;
const POOL_FIRST = 0xc0a80402;
const POOL_LAST = 0xc0a804fe;
const LEASE_SECONDS = 7200;
/** Server and client parts without an address take the next free one from here. */
const SERVERS_FIRST = 0xc0a8040a;
const LOG_LINES = 5;
/** How much of a response body a client part shows. */
const CLIENT_BODY_CHARS = 120;

/** BT100: what happened on the network (`NetRuntime.listen`). Times are bench ns. */
export type NetEvent =
  /** A board's station got its address (the DHCP server acknowledged it). */
  | { kind: 'connected'; at: number; board: string; ap: string; ip: number }
  /** A board's station left the AP, or lost it (switched off, rebuilt away). */
  | { kind: 'disconnected'; at: number; board: string; ap: string }
  /** A server part answered a request. */
  | { kind: 'served'; at: number; part: string; method: string; path: string; query: string; status: number; client: number }
  /** A client part's request ended: a status (0 with `error` when it failed) and the body as text. */
  | { kind: 'got'; at: number; part: string; method: string; url: string; status: number; error: string; body: string };

/** A board on an AP's LAN (`NetRuntime.stations`). */
export interface StationInfo {
  board: string;
  ap: string;
  ssid: string;
  mac: string;
  /** Its DHCP lease (0 while it has none). */
  ip: number;
  hostname: string;
  /** When it joined, bench ns. */
  since: number;
}

interface Station {
  port: LanPort;
  lost: () => void;
  /** The board's part id ('' for a radio without one). */
  board: string;
  /** The address its connected event reported (0: none yet). */
  ip: number;
  since: number;
}

/** One access point: its LAN, gateway and stations. */
export class AccessPoint {
  readonly id: string;
  readonly role: AccessPointRole;
  readonly bssid: number[];
  readonly clock: LanClock;
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
  /** The runtime's event sink (set when it owns this AP). */
  emit: (event: NetEvent) => void = () => {};
  /** BT101: the hosts its stations may reach (empty unless `internet`), and their addresses here. */
  readonly allow: AllowEntry[];
  private readonly outsideNames = new Map<number, string>();
  /** BT101: connections out now, and the last thing that went wrong out there ('' for none). */
  uplinkOpen = 0;
  uplinkError = '';

  constructor(id: string, role: AccessPointRole, clock: LanClock) {
    this.id = id;
    this.role = role;
    this.clock = clock;
    this.on = role.on;
    this.rssi = role.rssi;
    this.bssid = macFromName(`wifi-ap:${id}`);
    this.lan = new VirtualLan(clock);
    this.gateway = new IpHost(this.lan, { mac: this.bssid, ip: GATEWAY_IP, netmask: NETMASK });
    this.lan.attach(this.gateway, false);
    this.dhcp = new DhcpServer({ server: GATEWAY_IP, netmask: NETMASK, router: GATEWAY_IP, dns: GATEWAY_IP, first: POOL_FIRST, last: POOL_LAST, leaseSeconds: LEASE_SECONDS });
    this.dhcp.onack = (mac, ip) => {
      const station = this.stations.get(mac);
      if (station === undefined || station.ip === ip) return;
      station.ip = ip;
      if (station.board !== '') this.emit({ kind: 'connected', at: this.clock.now(), board: station.board, ap: this.id, ip });
    };
    this.gateway.bindUdp(DHCP_SERVER_PORT, (_from, data) => {
      const reply = this.dhcp.handle(data);
      if (reply === undefined) return;
      this.gateway.sendUdp(reply.broadcast ? BROADCAST_IP : reply.ip, DHCP_SERVER_PORT, DHCP_CLIENT_PORT, reply.data, reply.broadcast ? BROADCAST_MAC : reply.mac);
    });
    this.allow = role.internet ? parseAllowList(role.allow).entries : [];
    let next = OUTSIDE_FIRST;
    for (const entry of this.allow) {
      if (parseIp(entry.host) !== undefined || [...this.outsideNames.values()].includes(entry.host)) continue;
      this.outsideNames.set(next++, entry.host);
    }
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
    for (const [ip, host] of this.outsideNames) if (host === n) return ip;
    return undefined;
  }

  /** BT101: the host name an outside address stands for: an allowed name's, or an allowed IPv4 address itself. */
  outsideHost(ip: number): string | undefined {
    const name = this.outsideNames.get(ip);
    if (name !== undefined) return name;
    const literal = ipString(ip);
    return this.allow.some((e) => e.host === literal) ? literal : undefined;
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
      this.left(station);
      station.lost();
    }
  }

  /** A station is gone from this AP: say so for a board's. */
  left(station: Station): void {
    if (station.board !== '') this.emit({ kind: 'disconnected', at: this.clock.now(), board: station.board, ap: this.id });
  }

  visual(): VisualState {
    const clients = [...this.stations.keys()].map((mac) => {
      const ip = this.dhcp.leases.get(mac);
      return ip === undefined ? mac : leaseText(ip, this.dhcp.hostnames.get(mac));
    });
    const internet = !this.role.internet ? 'off' : this.uplinkError !== '' ? 'error' : this.uplinkOpen > 0 ? 'busy' : 'on';
    return { on: this.on, ssid: this.role.ssid, stations: this.stations.size, clients: clients.join('\n'), internet };
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
    this.host = new IpHost(ap.lan, { mac: macFromName(`http-server:${id}`), ip, netmask: NETMASK, router: GATEWAY_IP });
    ap.lan.attach(this.host, false);
    this.http = new HttpServer(this.host, role.port, parseRoutes(role.routes).routes);
    this.http.onrequest = (e) => ap.emit({ kind: 'served', at: e.at, part: id, method: e.method, path: e.path, query: e.query, status: e.status, client: e.client });
  }

  visual(): VisualState {
    const lines = this.http.log.slice(-LOG_LINES).map((e) => `${e.method} ${e.path} → ${e.status}`);
    return { address: `${ipString(this.host.ip)}:${this.role.port}`, hostname: this.role.hostname, requests: this.http.count, log: lines.join('\n') };
  }
}

/**
 * A request from `host` on `ap`'s LAN to `url` (http://host[:port]/path): the host part resolved
 * by the AP's names (or an address), then `httpRequest`. `done` gets the response or an error.
 */
function requestOnLan(ap: AccessPoint, host: IpHost, method: string, url: string, body: Uint8Array, headers: Record<string, string>, done: (result: HttpResult | string) => void): void {
  const parsed = parseHttpUrl(url);
  if (typeof parsed === 'string') {
    done(parsed);
    return;
  }
  const ip = parseIp(parsed.host) ?? ap.resolve(parsed.host);
  if (ip === undefined) {
    done(`no host "${parsed.host}" on "${ap.role.ssid}" (not a server part's hostname or a joined board's)`);
    return;
  }
  httpRequest(host, ip, parsed.port, { method, path: parsed.path, headers, body, hostname: parsed.host }, done);
}

/** A client part (BT100): its host on an AP's LAN, sending its request when pressed or on a timer. */
export class ClientHost {
  readonly id: string;
  readonly role: HttpClientRole;
  readonly ap: AccessPoint;
  readonly host: IpHost;
  /** Requests sent since the reset. */
  sent = 0;
  /** The last response's status (0: an error, or none yet), error and body. */
  status = 0;
  error = '';
  body = '';
  /** A request is in flight (the next press or tick waits for it). */
  busy = false;
  /** Bumped on every arm and at dispose: a timer from an older one does nothing. */
  private generation = 0;
  shown = '';

  constructor(id: string, role: HttpClientRole, ap: AccessPoint, ip: number) {
    this.id = id;
    this.role = role;
    this.ap = ap;
    this.host = new IpHost(ap.lan, { mac: macFromName(`http-client:${id}`), ip, netmask: NETMASK, router: GATEWAY_IP });
    ap.lan.attach(this.host, false);
  }

  /** Sends the request now, unless one is still in flight. */
  send(): void {
    if (this.busy) return;
    this.busy = true;
    this.sent++;
    const { method, url } = this.role;
    const body = this.role.body === '' ? new Uint8Array(0) : utf8Bytes(this.role.body);
    const generation = this.generation;
    requestOnLan(this.ap, this.host, method, url, body, {}, (result) => {
      if (generation !== this.generation) return;
      this.busy = false;
      if (typeof result === 'string') {
        this.status = 0;
        this.error = result;
        this.body = '';
      } else {
        this.status = result.status;
        this.error = '';
        this.body = utf8String(result.body);
      }
      this.ap.emit({ kind: 'got', at: this.ap.clock.now(), part: this.id, method, url, status: this.status, error: this.error, body: this.body });
    });
  }

  /** Starts its timer (a reset, a build): the first request `interval` ms from now. */
  arm(): void {
    const generation = ++this.generation;
    this.busy = false;
    const every = this.role.interval * 1e6;
    if (every <= 0) return;
    const clock = this.ap.clock;
    const tick = (): void => {
      if (generation !== this.generation) return;
      this.send();
      clock.schedule(clock.now() + every, tick);
    };
    clock.schedule(clock.now() + every, tick);
  }

  /** Its timer and any answer still coming do nothing from now on. */
  stop(): void {
    this.generation++;
  }

  visual(): VisualState {
    const status = this.status !== 0 ? String(this.status) : this.error !== '' ? 'error' : '';
    const body = this.error !== '' ? this.error : this.body.length > CLIENT_BODY_CHARS ? `${this.body.slice(0, CLIENT_BODY_CHARS - 1)}…` : this.body;
    return { url: this.role.url, method: this.role.method, status, body, sent: this.sent, busy: this.busy };
  }
}

/** Simulated time between uplink pumps while a connection is out, ns. */
const PUMP_NS = 1_000_000;

export class NetRuntime {
  /** A radio for a board without a part id (tests). */
  readonly radio: WifiRadio;
  private readonly aps: AccessPoint[];
  private readonly servers: ServerHost[];
  private readonly clients: ClientHost[];
  private readonly buildProblems: Problem[];
  private readonly listeners: ((event: NetEvent) => void)[] = [];
  private readonly clock: LanClock;
  /** BT101: the host's way out (null: none), the sockets open on it, what went wrong out there. */
  private readonly uplink: Uplink | null;
  private readonly sockets = new Set<UplinkSocket>();
  private readonly live = new Map<string, Problem>();
  private pumping = false;
  private pumpGeneration = 0;

  private constructor(aps: AccessPoint[], servers: ServerHost[], clients: ClientHost[], problems: Problem[], clock: LanClock, uplink: Uplink | null) {
    this.aps = aps;
    this.servers = servers;
    this.clients = clients;
    this.buildProblems = problems;
    this.clock = clock;
    this.uplink = uplink;
    for (const ap of aps) {
      ap.emit = (event) => this.emit(event);
      if (ap.allow.length > 0) ap.gateway.outside = (ip, port) => this.outside(ap, ip, port);
    }
    this.radio = this.radioFor('');
  }

  /**
   * The network of `parts` (an AP per access-point role). BT78: a rebuild passes the previous
   * bench's network: an AP with the same part id keeps its leases (the stations of kept boards
   * keep their addresses) and its on/off state.
   */
  static build(parts: readonly { id: string; type: string; props: PartProps }[], netSpecFor: NetSpecFor, clock: LanClock, previous: NetRuntime | null = null, uplink: Uplink | null = null): NetRuntime {
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
    const problems: Problem[] = [];
    // BT101: what an AP that lets boards out asks for.
    for (const ap of aps) {
      if (!ap.role.internet) continue;
      const { entries, errors } = parseAllowList(ap.role.allow);
      if (errors.length > 0) problems.push({ severity: 'warning', code: 'net-allow', message: `${ap.id}'s allow list: ${errors.slice(0, 3).join('; ')} — write one host:port a line, e.g. api.example.com:443.`, parts: [ap.id] });
      if (entries.length === 0) problems.push({ severity: 'warning', code: 'net-allow', message: `${ap.id} lets boards reach the internet but allows no host: add host:port lines to its allow list.`, parts: [ap.id] });
      else if (uplink === null) problems.push({ severity: 'warning', code: 'net-no-uplink', message: `${ap.id} lets boards reach ${entries.length === 1 ? `${entries[0].host}:${entries[0].port}` : `${entries.length} hosts`}, but this run has no way out: give the command --network with the same host:port entries.`, parts: [ap.id] });
    }
    // Hosts on the LANs: server parts (BT99) and client parts (BT100). Those asking for an
    // address first, so an automatic one never takes it.
    const servers: ServerHost[] = [];
    const clients: ClientHost[] = [];
    const asked: { id: string; role: HttpServerRole | HttpClientRole }[] = [];
    for (const part of parts) {
      const role = netSpecFor(part.type, part.props);
      if (role?.kind === 'http-server' || role?.kind === 'http-client') asked.push({ id: part.id, role });
    }
    const addressOf = (role: HttpServerRole | HttpClientRole): number => (role.kind === 'http-server' ? role.address : 0);
    asked.sort((a, b) => (addressOf(a.role) === 0 ? 1 : 0) - (addressOf(b.role) === 0 ? 1 : 0));
    const hosts = new Map<AccessPoint, number[]>();
    for (const part of asked) {
      const role = part.role;
      const ap = role.network === '' ? aps[0] : aps.find((a) => a.role.ssid === role.network);
      if (ap === undefined) {
        problems.push({ severity: 'warning', code: 'net-no-access-point', message: role.network === '' ? `${part.id} needs a WiFi access point on the bench: it sits on its network.` : `${part.id} sits on the network "${role.network}", and no access point has that SSID.`, parts: [part.id] });
        continue;
      }
      const used = hosts.get(ap) ?? [];
      hosts.set(ap, used);
      const taken = (ip: number): boolean => ip === GATEWAY_IP || used.includes(ip);
      let ip = addressOf(role);
      if (ip !== 0 && ((ip & NETMASK) !== (GATEWAY_IP & NETMASK) || taken(ip) || (ip & 0xff) === 0 || (ip & 0xff) === 0xff)) {
        problems.push({ severity: 'warning', code: 'net-bad-address', message: `${part.id}'s address ${ipString(ip)} isn't free on 192.168.4.0/24: it takes the next free one.`, parts: [part.id] });
        ip = 0;
      }
      if (ip === 0) for (ip = SERVERS_FIRST; taken(ip); ip++);
      used.push(ip);
      ap.dhcp.reserved.add(ip);
      if (role.kind === 'http-client') {
        clients.push(new ClientHost(part.id, role, ap, ip));
        continue;
      }
      const server = new ServerHost(part.id, role, ap, ip);
      ap.servers.push(server);
      servers.push(server);
      const { errors } = parseRoutes(role.routes);
      if (errors.length > 0) problems.push({ severity: 'warning', code: 'http-routes', message: `${part.id}'s routes skip ${errors.length === 1 ? 'a line' : `${errors.length} lines`}: ${errors.slice(0, 3).join('; ')}`, parts: [part.id] });
    }
    for (const client of clients) {
      if (parseHttpUrl(client.role.url) instanceof Object) continue;
      problems.push({ severity: 'warning', code: 'http-url', message: `${client.id}'s URL "${client.role.url}" isn't one it can send to: ${parseHttpUrl(client.role.url) as string}.`, parts: [client.id] });
    }
    // In document order (the views and tools list them so).
    const order = new Map(parts.map((p, i) => [p.id, i]));
    const byOrder = (a: { id: string }, b: { id: string }): number => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
    servers.sort(byOrder);
    clients.sort(byOrder);
    const net = new NetRuntime(aps, servers, clients, problems, clock, uplink);
    // A carried bench isn't reset: its clients' timers start now (a reset re-arms them).
    for (const client of clients) client.arm();
    return net;
  }

  /** What the build found wrong (a server without its AP, a bad address, route lines skipped, a bad URL, an allow list). */
  problems(): readonly Problem[] {
    return this.buildProblems;
  }

  /** BT101: what went wrong while running — an uplink that refused or lost a connection — newest per AP. */
  liveProblems(): readonly Problem[] {
    return [...this.live.values()];
  }

  /**
   * BT101: a station's SYN to `ip`:`port` beyond the LAN — an allowed host's address: the way to
   * open it through the uplink, the station's SYN-ACK waiting until the far end answers.
   */
  private outside(ap: AccessPoint, ip: number, port: number): ReturnType<OutsideTcp> {
    const host = ap.outsideHost(ip);
    if (host === undefined || !allows(ap.allow, host, port)) return undefined;
    return (accept, refuse) => {
      const uplink = this.uplink;
      if (uplink === null) {
        this.fail(ap, host, port, 'this run has no way out (--network)');
        refuse();
        return;
      }
      let connection: TcpConnection | null = null;
      let done = false;
      ap.uplinkOpen++;
      const finish = (): void => {
        if (done) return;
        done = true;
        ap.uplinkOpen--;
        this.sockets.delete(socket);
      };
      const socket = uplink.connect(host, port, {
        opened: () => {
          if (done) return;
          const took = accept((c) => {
            connection = c;
            c.ondata = (bytes) => socket.send(bytes);
            c.onpeerclose = () => socket.end();
            c.onend = () => {
              if (done) return;
              finish();
              socket.close();
            };
          });
          if (!took) {
            finish();
            socket.close();
          }
        },
        data: (bytes) => {
          if (!done) connection?.send(bytes);
        },
        closed: (error) => {
          if (done) return;
          finish();
          if (error !== null) this.fail(ap, host, port, error);
          const c = connection as TcpConnection | null;
          if (c === null) refuse();
          else if (error !== null) c.abort();
          else c.close();
        },
      });
      this.sockets.add(socket);
      this.startPump();
    };
  }

  private fail(ap: AccessPoint, host: string, port: number, error: string): void {
    ap.uplinkError = `${host}:${port}: ${error}`;
    this.live.set(ap.id, { severity: 'warning', code: 'net-internet', message: `${ap.id} couldn't reach ${host}:${port}: ${error}.`, parts: [ap.id] });
  }

  /** A synchronous uplink's pump, every simulated millisecond while a socket is open. */
  private startPump(): void {
    const uplink = this.uplink;
    if (uplink?.pump === undefined || this.pumping) return;
    this.pumping = true;
    const generation = this.pumpGeneration;
    const tick = (): void => {
      if (generation !== this.pumpGeneration) return;
      uplink.pump?.(this.clock.now());
      if (this.sockets.size === 0) {
        this.pumping = false;
        return;
      }
      this.clock.schedule(this.clock.now() + PUMP_NS, tick);
    };
    this.clock.schedule(this.clock.now() + PUMP_NS, tick);
  }

  /** Closes every uplink socket (a reset, a dispose): nothing more comes in. */
  private closeUplink(): void {
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
    this.pumpGeneration++;
    this.pumping = false;
    this.live.clear();
    for (const ap of this.aps) {
      ap.uplinkOpen = 0;
      ap.uplinkError = '';
    }
  }

  get serverHosts(): readonly ServerHost[] {
    return this.servers;
  }

  get clientHosts(): readonly ClientHost[] {
    return this.clients;
  }

  /** BT100: calls `listener` with every event from now on; returns the call that stops it. */
  listen(listener: (event: NetEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private emit(event: NetEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** BT100: every station on an AP's LAN now, by AP in document order. */
  stations(): StationInfo[] {
    const out: StationInfo[] = [];
    for (const ap of this.aps) {
      for (const [mac, station] of ap.stations) {
        out.push({ board: station.board, ap: ap.id, ssid: ap.role.ssid, mac, ip: ap.dhcp.leases.get(mac) ?? 0, hostname: ap.dhcp.hostnames.get(mac) ?? '', since: station.since });
      }
    }
    return out;
  }

  /**
   * BT100: an HTTP request from the gateway of the AP whose SSID is `network` (the first AP when
   * empty) to `url` on its LAN — a board's web server by hostname or address, a server part.
   * `done` gets the response, or an error (no such AP, a bad URL, an unknown host, refused, timed out).
   */
  request(network: string, method: string, url: string, body: Uint8Array, headers: Record<string, string>, done: (result: HttpResult | string) => void): void {
    const ap = network === '' ? this.aps[0] : this.aps.find((a) => a.role.ssid === network);
    if (ap === undefined) {
      done(network === '' ? 'the bench has no WiFi access point' : `no access point has the SSID "${network}"`);
      return;
    }
    if (!ap.on) {
      done(`the access point "${ap.role.ssid}" is off`);
      return;
    }
    requestOnLan(ap, ap.gateway, method, url, body, headers, done);
  }

  /** A bench reset: every AP as the document has it, no stations, no leases; clients start over. */
  reset(): void {
    this.closeUplink();
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
    for (const client of this.clients) {
      client.host.reset();
      client.sent = 0;
      client.status = 0;
      client.error = '';
      client.body = '';
      client.shown = '';
      client.arm();
    }
  }

  /** This bench is done (a rebuild took over): frames still in the air reach nobody. */
  dispose(): void {
    this.closeUplink();
    for (const ap of this.aps) {
      for (const station of ap.stations.values()) ap.lan.detach(station.port);
      ap.stations.clear();
      ap.lan.detach(ap.gateway);
      for (const server of ap.servers) ap.lan.detach(server.host);
    }
    for (const client of this.clients) {
      client.stop();
      client.ap.lan.detach(client.host);
    }
    this.listeners.length = 0;
  }

  get accessPoints(): readonly AccessPoint[] {
    return this.aps;
  }

  owns(partId: string): boolean {
    return this.aps.some((ap) => ap.id === partId) || this.servers.some((s) => s.id === partId) || this.clients.some((c) => c.id === partId);
  }

  /**
   * An AP: `set:on=0|1` and `set:rssi=<dBm>` (key down), press (on) and release (off). A client
   * part: press sends its request.
   */
  input(partId: string, event: PartInput): void {
    const client = this.clients.find((c) => c.id === partId);
    if (client !== undefined) {
      if (event.kind === 'press') client.send();
      return;
    }
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

  /** Visual states of the APs and hosts that changed since the last call. */
  collect(out: [string, VisualState][]): void {
    for (const item of [...this.aps, ...this.servers, ...this.clients]) {
      const state = item.visual();
      const key = JSON.stringify(state);
      if (key === item.shown) continue;
      item.shown = key;
      out.push([item.id, state]);
    }
  }

  /** Every AP's and host's state now (a rebuilt or reset bench shows them once). */
  invalidate(): void {
    for (const item of [...this.aps, ...this.servers, ...this.clients]) item.shown = '';
  }

  /** BT100: the radio a board's MCU gets — its station is filed under the board's part id. */
  radioFor(board: string): WifiRadio {
    return {
      accessPoints: () => this.aps.filter((ap) => ap.on).map((ap) => ap.info()),
      join: (bssid, mac, receive, lost) => this.join(board, bssid, mac, receive, lost),
    };
  }

  private join(board: string, bssid: Mac, mac: Mac, receive: (frame: Uint8Array) => void, lost: () => void): WifiLink | undefined {
    const ap = this.aps.find((a) => a.on && a.bssid.every((b, i) => b === bssid[i]));
    if (ap === undefined) return undefined;
    const key = macString(mac);
    const previous = ap.stations.get(key);
    if (previous !== undefined) ap.lan.detach(previous.port);
    const port: LanPort = { mac: [...mac], deliver: receive };
    ap.lan.attach(port, true);
    const station: Station = { port, lost, board, ip: 0, since: ap.clock.now() };
    ap.stations.set(key, station);
    return {
      send: (frame) => ap.lan.send(port, frame),
      leave: () => {
        ap.lan.detach(port);
        if (ap.stations.get(key) !== station) return;
        ap.stations.delete(key);
        ap.left(station);
      },
    };
  }
}
