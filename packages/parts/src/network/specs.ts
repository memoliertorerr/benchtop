/**
 * `netSpecFor(type, props)` for the bench's virtual network (BT98, `BenchOptions.netSpecFor`):
 * the access point's role from its props, clamped to what a router allows — channel 1–13, RSSI
 * −100…−20 dBm, an SSID of at most 32 UTF-8 bytes, a WPA key of 8–63 characters (a shorter or
 * longer one makes it open, as a router refuses it; the view says so). BT99: the HTTP server's —
 * an address that doesn't parse means "the next free one", a port outside 1–65535 means 80.
 * BT100: the HTTP client's — a method it can't send means GET, an interval under 50 ms 50 ms
 * (0 or less: only when pressed).
 */

import type { NetRole, PartProps, WifiSecurity } from '@benchtop/core';
import { dnsName, parseIp, WIFI_SECURITIES } from '@benchtop/core';
import { DEFAULT_ROUTES } from './http-server.ts';

const utf8Length = (text: string): number => {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
};

/** The SSID cut to 32 UTF-8 bytes. */
export function wifiSsid(value: unknown): string {
  let ssid = typeof value === 'string' ? value : 'benchtop';
  while (utf8Length(ssid) > 32) ssid = [...ssid].slice(0, -1).join('');
  return ssid;
}

/** The security a router would run with this key: WPA needs 8–63 characters, WEP 5 or 13. */
export function wifiSecurity(security: unknown, password: string): WifiSecurity {
  const asked = WIFI_SECURITIES.includes(security as WifiSecurity) ? (security as WifiSecurity) : 'wpa2';
  if (asked === 'open') return 'open';
  if (asked === 'wep') return password.length === 5 || password.length === 13 ? 'wep' : 'open';
  return password.length >= 8 && password.length <= 63 ? asked : 'open';
}

/** The methods a client part may send (anything else sends GET). */
const CLIENT_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']);
/** A client part's shortest interval, ms (a faster one would flood a board's server). */
export const MIN_CLIENT_INTERVAL_MS = 50;

export function netSpecFor(type: string, props: PartProps): NetRole | undefined {
  if (type === 'http-client') {
    const method = typeof props.method === 'string' ? props.method.trim().toUpperCase() : 'GET';
    const interval = typeof props.interval === 'number' && Number.isFinite(props.interval) && props.interval > 0 ? Math.max(MIN_CLIENT_INTERVAL_MS, Math.round(props.interval)) : 0;
    return {
      kind: 'http-client',
      network: typeof props.network === 'string' ? props.network : '',
      url: typeof props.url === 'string' ? props.url : '',
      method: CLIENT_METHODS.has(method) ? method : 'GET',
      body: typeof props.body === 'string' ? props.body : '',
      interval,
    };
  }
  if (type === 'http-server') {
    const port = typeof props.port === 'number' && Number.isInteger(props.port) && props.port >= 1 && props.port <= 65535 ? props.port : 80;
    return {
      kind: 'http-server',
      network: typeof props.network === 'string' ? props.network : '',
      address: typeof props.address === 'string' ? (parseIp(props.address) ?? 0) : 0,
      port,
      hostname: typeof props.hostname === 'string' ? dnsName(props.hostname) : '',
      routes: typeof props.routes === 'string' ? props.routes : DEFAULT_ROUTES,
    };
  }
  if (type !== 'wifi-ap') return undefined;
  const password = typeof props.password === 'string' ? props.password : '';
  const security = wifiSecurity(props.security, password);
  const num = (value: unknown, fallback: number, min: number, max: number): number => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback);
  return {
    kind: 'access-point',
    ssid: wifiSsid(props.ssid),
    password: security === 'open' ? '' : password,
    security,
    channel: num(props.channel, 6, 1, 13),
    rssi: num(props.rssi, -50, -100, -20),
    hidden: props.hidden === true,
    on: props.on !== false,
    internet: props.internet === true,
    allow: typeof props.allow === 'string' ? props.allow : '',
  };
}
