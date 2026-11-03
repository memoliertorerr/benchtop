/**
 * The WiFi access point (BT98): a home router on the bench, with no pins — boards with WiFi
 * reach it over the air. The bench's network (`@benchtop/core` net/) owns it: its LAN, a gateway
 * at 192.168.4.1 with a DHCP server (and, BT99, DNS), the stations that joined. Props: the SSID,
 * the password (WPA2 by default; `security` 'open' takes none), the channel (1–13), the signal
 * strength a station sees (`rssi`, dBm), whether the SSID is hidden, and whether it is on at the
 * start — `set:on=0|1` (the Inspector's Power toggle) switches it while running.
 */

import { definePart } from '../define.ts';
import { httpServer } from './http-server.ts';

export const wifiAp = definePart({
  type: 'wifi-ap',
  title: 'WiFi access point',
  category: 'network',
  size: { w: 34, h: 24 },
  pins: [],
  defaults: { ssid: 'benchtop', password: 'simulated', security: 'wpa2', channel: 6, rssi: -50, hidden: false, on: true },
});

export const NETWORK_PARTS = [wifiAp, httpServer];
