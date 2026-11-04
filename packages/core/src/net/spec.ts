/**
 * What the virtual network needs to know about a part type (BT98): whether it is an access point,
 * (BT99) a server on one's LAN or (BT100) a client on it. Not part of the frozen contracts — the
 * bench takes a `netSpecFor(type, props)` function as an option, like `envSpecFor`;
 * `@benchtop/parts` provides one.
 */

import type { PartProps } from '../contracts/part.ts';
import type { WifiSecurity } from './radio.ts';

export interface AccessPointRole {
  kind: 'access-point';
  ssid: string;
  password: string;
  security: WifiSecurity;
  channel: number;
  rssi: number;
  hidden: boolean;
  /** On at the start (`set:on=0|1` switches it while running). */
  on: boolean;
  /** BT101: boards may reach the real network — the hosts `allow` names, through the host's uplink. */
  internet: boolean;
  /** BT101: `host:port` entries, a line or a comma apart (net/uplink.ts `parseAllowList`). */
  allow: string;
}

/** BT99: an HTTP server on an access point's LAN. */
export interface HttpServerRole {
  kind: 'http-server';
  /** The SSID of the AP whose LAN it sits on ('' = the first AP on the bench). */
  network: string;
  /** Its IPv4 address; 0 = the next free one from 192.168.4.10. */
  address: number;
  port: number;
  /** Its name in the gateway's DNS ('' = none). */
  hostname: string;
  /** The routes (net/http.ts's format). */
  routes: string;
}

/** BT100: an HTTP client on an access point's LAN (the `http-client` part). */
export interface HttpClientRole {
  kind: 'http-client';
  /** The SSID of the AP whose LAN it sits on ('' = the first AP on the bench). */
  network: string;
  /** http://host[:port]/path — a name the gateway's DNS knows, or an address. */
  url: string;
  method: string;
  /** The request body ('' for none). */
  body: string;
  /** Milliseconds between requests; 0 = only when pressed. */
  interval: number;
}

export type NetRole = AccessPointRole | HttpServerRole | HttpClientRole;

export type NetSpecFor = (type: string, props: PartProps) => NetRole | undefined;
