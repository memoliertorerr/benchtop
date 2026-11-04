/**
 * The HTTP client (BT100): a host on an access point's LAN that sends one request — to a board's
 * web server (Arduino's WebServer on an ESP32) or an http-server part — each time it is pressed
 * (the Inspector's Send), and every `interval` ms while that is above 0. No pins. The bench's
 * network (`@benchtop/core` net/) runs it: `url` is `http://<host>[:port][/path][?query]`, the
 * host a name the gateway's DNS knows (a board's DHCP hostname, a server part's) or an address;
 * `method` and `body` are the request's. It sits on the LAN of the AP whose SSID is `network`
 * (the first AP when empty) at the next free address from 192.168.4.10, and shows its last
 * answer: the status, the body's start, how many it sent.
 */

import { definePart } from '../define.ts';

export const httpClient = definePart({
  type: 'http-client',
  title: 'HTTP client',
  category: 'network',
  size: { w: 30, h: 22 },
  pins: [],
  defaults: { url: 'http://esp32-web/', method: 'GET', body: '', interval: 0, network: '' },
});
