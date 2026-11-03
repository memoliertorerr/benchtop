/**
 * The access point's DNS server (BT99; RFC 1035, what a resolver like lwIP's asks): one question
 * a query, class IN. An A question for a name the LAN knows — a server part's hostname, a
 * station's DHCP hostname — is answered with its address (TTL 60 s); a known name asked for
 * another type gets no answer (NOERROR); an unknown name gets NXDOMAIN. Names compare without
 * case and without a trailing dot. Compression pointers in questions are refused (FORMERR):
 * resolvers don't use them there.
 */

import { be16, setBe16, setBe32 } from './packet.ts';

export const DNS_PORT = 53;
const TYPE_A = 1;
const CLASS_IN = 1;
const RCODE_FORMERR = 1;
const RCODE_NXDOMAIN = 3;

export interface DnsQuestion {
  id: number;
  name: string;
  type: number;
  qclass: number;
  /** The question section's end (for echoing it). */
  end: number;
  recursion: boolean;
}

/** A standard query's question, or undefined (a response, several questions, a malformed name). */
export function parseDnsQuery(p: Uint8Array): DnsQuestion | undefined {
  if (p.length < 12 || (p[2] & 0x80) !== 0 || ((p[2] >> 3) & 15) !== 0 || be16(p, 4) !== 1) return undefined;
  const labels: string[] = [];
  let i = 12;
  for (;;) {
    if (i >= p.length) return undefined;
    const length = p[i];
    if (length === 0) {
      i++;
      break;
    }
    if (length > 63 || i + 1 + length > p.length) return undefined;
    labels.push(String.fromCharCode(...p.subarray(i + 1, i + 1 + length)));
    i += 1 + length;
  }
  if (i + 4 > p.length) return undefined;
  return { id: be16(p, 0), name: labels.join('.').toLowerCase(), type: be16(p, i), qclass: be16(p, i + 2), end: i + 4, recursion: (p[2] & 1) !== 0 };
}

/** A name as the server keys it: lower case, no trailing dot. */
export function dnsName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
}

export class DnsServer {
  /** Names → IPv4 addresses (a function: the LAN's names change as stations join). */
  private readonly lookup: (name: string) => number | undefined;
  /** Queries answered, and the names asked (for the views and tests). */
  queries = 0;
  readonly asked: string[] = [];

  constructor(lookup: (name: string) => number | undefined) {
    this.lookup = lookup;
  }

  /** The response to a query, or undefined (not a query: no answer at all). */
  handle(p: Uint8Array): Uint8Array | undefined {
    if (p.length < 12 || (p[2] & 0x80) !== 0) return undefined;
    const q = parseDnsQuery(p);
    if (q === undefined) return this.error(p, RCODE_FORMERR);
    this.queries++;
    if (this.asked.length < 64) this.asked.push(q.name);
    const ip = q.qclass === CLASS_IN ? this.lookup(q.name) : undefined;
    const answer = ip !== undefined && q.type === TYPE_A;
    const out = new Uint8Array(q.end + (answer ? 16 : 0));
    out.set(p.subarray(0, q.end));
    out[2] = 0x84 | (q.recursion ? 1 : 0); // QR, AA, RD as asked
    out[3] = ip === undefined ? RCODE_NXDOMAIN : 0; // RA = 0: it resolves only its own names
    setBe16(out, 4, 1);
    setBe16(out, 6, answer ? 1 : 0);
    setBe16(out, 8, 0);
    setBe16(out, 10, 0);
    if (answer) {
      const a = q.end;
      setBe16(out, a, 0xc00c); // the question's name
      setBe16(out, a + 2, TYPE_A);
      setBe16(out, a + 4, CLASS_IN);
      setBe32(out, a + 6, 60);
      setBe16(out, a + 10, 4);
      setBe32(out, a + 12, ip);
    }
    return out;
  }

  private error(p: Uint8Array, rcode: number): Uint8Array {
    const out = p.slice(0, 12);
    out[2] = 0x80 | (p[2] & 1);
    out[3] = rcode;
    setBe16(out, 4, 0);
    setBe16(out, 6, 0);
    setBe16(out, 8, 0);
    setBe16(out, 10, 0);
    return out;
  }
}

/** A query for `name` (A, IN, recursion desired) — the tests' and the bench's own resolver's. */
export function dnsQuery(id: number, name: string, type = TYPE_A): Uint8Array {
  const labels = dnsName(name).split('.').filter((l) => l !== '');
  const length = labels.reduce((n, l) => n + 1 + l.length, 0) + 1;
  const p = new Uint8Array(12 + length + 4);
  setBe16(p, 0, id);
  p[2] = 1;
  setBe16(p, 4, 1);
  let i = 12;
  for (const label of labels) {
    p[i++] = label.length;
    for (let k = 0; k < label.length; k++) p[i++] = label.charCodeAt(k) & 0xff;
  }
  p[i++] = 0;
  setBe16(p, i, type);
  setBe16(p, i + 2, CLASS_IN);
  return p;
}
