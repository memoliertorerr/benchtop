/**
 * What the virtual network needs to know about a part type (BT98): whether it is an access point
 * or (BT99) a server on one's LAN. Not part of the frozen contracts — the bench takes a
 * `netSpecFor(type, props)` function as an option, like `envSpecFor`; `@benchtop/parts` provides
 * one.
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

export type NetRole = AccessPointRole | HttpServerRole;

export type NetSpecFor = (type: string, props: PartProps) => NetRole | undefined;
