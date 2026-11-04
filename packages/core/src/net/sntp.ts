/**
 * The gateway's time server (BT105): SNTP (RFC 4330) in client/server mode on UDP 123, so a
 * sketch's `configTime()` gets the time on the virtual network without the internet. A request
 * is a 48-byte (or longer) NTP packet in mode 3; the answer is mode 4, stratum 2, its originate
 * timestamp the request's transmit timestamp (what lwIP's SNTP client checks), receive and
 * transmit the clock's now, the reference timestamp the clock's start. Timestamps are NTP's
 * 64-bit fixed point: seconds since 1900-01-01 and a 32-bit fraction.
 */

export const NTP_PORT = 123;
const NTP_PACKET = 48;
/** Seconds from 1900-01-01 (NTP's era 0) to 1970-01-01 (Unix). */
const NTP_UNIX_OFFSET = 2_208_988_800;
const MODE_CLIENT = 3;
const MODE_SERVER = 4;
/** The names a gateway with a clock answers for itself (their subdomains too for pool.ntp.org). */
export const NTP_NAMES = ['pool.ntp.org', 'time.google.com', 'time.cloudflare.com', 'time.nist.gov', 'time.windows.com', 'time.apple.com'];

/** Whether `name` (lowercased, no trailing dot) is a time server name the gateway takes. */
export function isNtpName(name: string): boolean {
  return NTP_NAMES.includes(name) || name.endsWith('.pool.ntp.org');
}

function putTimestamp(p: Uint8Array, at: number, unixMs: number): void {
  const seconds = Math.floor(unixMs / 1000) + NTP_UNIX_OFFSET;
  const fraction = Math.floor(((unixMs % 1000) / 1000) * 0x100000000);
  p[at] = seconds >>> 24;
  p[at + 1] = (seconds >>> 16) & 0xff;
  p[at + 2] = (seconds >>> 8) & 0xff;
  p[at + 3] = seconds & 0xff;
  p[at + 4] = fraction >>> 24;
  p[at + 5] = (fraction >>> 16) & 0xff;
  p[at + 6] = (fraction >>> 8) & 0xff;
  p[at + 7] = fraction & 0xff;
}

/** Unix ms from an NTP timestamp at `at` (tests). */
export function ntpTimestamp(p: Uint8Array, at: number): number {
  const seconds = ((p[at] << 24) | (p[at + 1] << 16) | (p[at + 2] << 8) | p[at + 3]) >>> 0;
  const fraction = ((p[at + 4] << 24) | (p[at + 5] << 16) | (p[at + 6] << 8) | p[at + 7]) >>> 0;
  return (seconds - NTP_UNIX_OFFSET) * 1000 + Math.round((fraction / 0x100000000) * 1000);
}

/**
 * The answer to an SNTP request, or undefined for anything that isn't one (too short, not mode
 * 3). `nowMs` and `startMs` are Unix ms: the clock now, and when it started (the reference).
 */
export function sntpAnswer(request: Uint8Array, nowMs: number, startMs: number): Uint8Array | undefined {
  if (request.length < NTP_PACKET || (request[0] & 7) !== MODE_CLIENT) return undefined;
  const version = (request[0] >>> 3) & 7;
  const p = new Uint8Array(NTP_PACKET);
  p[0] = (0 << 6) | ((version === 0 ? 4 : version) << 3) | MODE_SERVER; // LI 0: no warning
  p[1] = 2; // stratum: a secondary server
  p[2] = request[2]; // poll, echoed
  p[3] = 0xec; // precision: 2^-20 s
  // root delay and dispersion: small (1/65536 s); reference id: "BNCH"
  p[6] = 0;
  p[7] = 1;
  p[10] = 0;
  p[11] = 1;
  p.set([0x42, 0x4e, 0x43, 0x48], 12);
  putTimestamp(p, 16, startMs); // reference: when the clock was set
  p.set(request.subarray(40, 48), 24); // originate = the client's transmit timestamp
  putTimestamp(p, 32, nowMs); // receive
  putTimestamp(p, 40, nowMs); // transmit
  return p;
}
