/**
 * The HTTP server (BT99): a web server on an access point's LAN, answering requests from the
 * boards — the API a sketch's HTTPClient calls, a page it fetches. No pins. The bench's network
 * (`@benchtop/core` net/) runs it: an IPv4 host on the LAN of the AP whose SSID is `network` (the
 * first AP when empty), at `address` (the next free one from 192.168.4.10 when empty), with
 * `hostname` in the gateway's DNS, answering on `port` from `routes` (net/http.ts has the format:
 * `METHOD /path STATUS [content-type [body]]` a line, with {{placeholders}}).
 */

import { definePart } from '../define.ts';

export const DEFAULT_ROUTES = [
  'GET / 200 text/html <h1>Hello from the bench</h1>',
  'GET /api/hello 200 application/json {"hello":"world","count":{{count}}}',
  'GET /api/time 200 application/json {"seconds":{{time}}}',
  'POST /api/echo 200 text/plain {{body}}',
].join('\n');

export const httpServer = definePart({
  type: 'http-server',
  title: 'HTTP server',
  category: 'network',
  size: { w: 30, h: 22 },
  pins: [],
  defaults: { hostname: 'api.bench', address: '', port: 80, network: '', routes: DEFAULT_ROUTES },
});
