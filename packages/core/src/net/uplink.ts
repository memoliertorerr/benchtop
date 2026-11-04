/**
 * The real network (BT101), as a host provides it: an `Uplink` opens TCP connections to hosts
 * outside the bench — the compile bridge does it for the browser, sockets in a worker thread for
 * the CLI. Off unless both sides opt in: the project's access point (`internet`, and its `allow`
 * list of `host:port` lines) and the user who started the host (its own `--network` list). The
 * bench reaches only what both lists name. Not part of the frozen contracts: `BenchOptions.uplink`.
 *
 * Inside the bench the access point's gateway answers DNS for an allowed name with an address
 * from 198.18.0.0/15 (RFC 2544's benchmarking block — never routed, so it can't collide with a
 * real one) and takes TCP to it as a proxy would: a station's SYN opens the real connection, and
 * only when that is open does the station get its SYN-ACK (a refusal is an RST, as from the real
 * server). An allowed IPv4 address works the same without DNS. TCP only: no UDP (NTP, MQTT over
 * UDP), no ICMP beyond the LAN.
 */

/** What the host tells about one connection. */
export interface UplinkEvents {
  /** The connection is open. */
  opened(): void;
  /** Bytes from the far end, in order. */
  data(bytes: Uint8Array): void;
  /** It ended: the far end closed (`error` null), it failed or the host refused it (why). */
  closed(error: string | null): void;
}

export interface UplinkSocket {
  send(bytes: Uint8Array): void;
  /** Sends no more (a half close: the far end may still answer). */
  end(): void;
  /** Closes it (no more events after). */
  close(): void;
}

export interface Uplink {
  /** Opens a TCP connection to `host`:`port`; its events come later. */
  connect(host: string, port: number, events: UplinkEvents): UplinkSocket;
  /**
   * A synchronous host (the CLI) delivers what arrived here; the bench calls it every
   * millisecond of simulated time while a connection is open. It may also hold simulated time
   * back to the wall clock, so a firmware's timeouts see real latencies. An asynchronous host
   * (the browser's worker) delivers between simulation slices and has none.
   */
  pump?(nowNs: number): void;
}

/** One `host:port` an allow list names (host lowercased, without a trailing dot). */
export interface AllowEntry {
  host: string;
  port: number;
}

/** The longest allow list a project or host may give. */
export const MAX_ALLOW_ENTRIES = 32;

/**
 * An allow list from text: `host:port` entries separated by lines or commas, `#` starting a
 * comment. A host is a DNS name (letters, digits, '-', '.'; no wildcards) or an IPv4 address;
 * the port 1–65535 is required.
 */
export function parseAllowList(text: string): { entries: AllowEntry[]; errors: string[] } {
  const entries: AllowEntry[] = [];
  const errors: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const item = raw.replace(/#.*/, '').trim();
    if (item === '') continue;
    const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)\.?:(\d{1,5})$/.exec(item);
    const port = m === null ? 0 : Number(m[2]);
    if (m === null || port < 1 || port > 65535 || m[1].length > 253) {
      errors.push(`"${item.length > 40 ? `${item.slice(0, 39)}…` : item}" isn't host:port`);
      continue;
    }
    if (entries.length >= MAX_ALLOW_ENTRIES) {
      errors.push(`more than ${MAX_ALLOW_ENTRIES} entries`);
      break;
    }
    const host = m[1].toLowerCase();
    if (!entries.some((e) => e.host === host && e.port === port)) entries.push({ host, port });
  }
  return { entries, errors };
}

/** Whether `list` names `host`:`port` (the host without case or a trailing dot). */
export function allows(list: readonly AllowEntry[], host: string, port: number): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return list.some((e) => e.host === h && e.port === port);
}

/** 198.18.0.0/15: the addresses the gateway gives allowed names (198.18.0.1 on). */
export const OUTSIDE_FIRST = 0xc6120001;
export const OUTSIDE_MASK = 0xfffe0000;
