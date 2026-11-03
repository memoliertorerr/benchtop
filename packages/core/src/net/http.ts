/**
 * HTTP/1.1 on the virtual LAN (BT99): the server behind the `http-server` part, and a client for
 * the bench's own tools (BT100: the MCP server's `sim_http`, spec assertions, tests). Small and
 * strict, like a device's: one request per connection (every response says `Connection: close`
 * and closes), bodies by Content-Length only (a chunked request is 411), headers up to 8 KB, a
 * body up to 64 KB.
 *
 * Routes (the part's `routes` prop, one a line, `#` starts a comment):
 *   METHOD PATH STATUS [CONTENT-TYPE [BODY…]]
 * METHOD is GET, POST, PUT, DELETE, PATCH, HEAD or * (any); PATH matches the request's path
 * without its query, exactly or — ending in * — by prefix. The first route that matches wins; a
 * path some route has but not with this method is 405, no route 404. BODY runs to the end of the
 * line, with `\n` for a newline and placeholders filled in per request: {{method}}, {{path}},
 * {{query}}, {{body}} (the request's), {{client}} (its address), {{count}} (requests so far,
 * this one included), {{time}} (bench seconds, three decimals). HEAD gets GET's headers and no
 * body.
 */

import type { IpHost } from './host.ts';
import { ipString } from './packet.ts';
import type { TcpConnection } from './tcp.ts';

export interface HttpRoute {
  method: string;
  path: string;
  status: number;
  type: string;
  body: string;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', '*']);
const MAX_HEADERS = 8192;
const MAX_BODY = 65536;
const LOG_SIZE = 200;

export const REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  411: 'Length Required',
  413: 'Content Too Large',
  418: "I'm a teapot",
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** Routes from the prop's text; a line that doesn't parse is reported in `errors` and skipped. */
export function parseRoutes(text: string): { routes: HttpRoute[]; errors: string[] } {
  const routes: HttpRoute[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const match = /^(\S+)\s+(\S+)\s+(\d{3})(?:\s+(\S+)(?:\s+(.*))?)?$/.exec(line);
    const method = match?.[1].toUpperCase() ?? '';
    if (match === null || !METHODS.has(method) || !match[2].startsWith('/')) {
      errors.push(`line ${i + 1}: "${line}" — expected METHOD /path STATUS [content-type [body]]`);
      return;
    }
    routes.push({ method, path: match[2], status: Number(match[3]), type: match[4] ?? 'text/plain', body: (match[5] ?? '').replace(/\\n/g, '\n') });
  });
  return { routes, errors };
}

export interface HttpRequest {
  method: string;
  /** The target's path, without the query. */
  path: string;
  query: string;
  version: string;
  /** Header names in lower case. */
  headers: Map<string, string>;
  body: Uint8Array;
}

/** A request at the start of `buffer`: the request and the bytes it took, or why not yet. */
export function parseRequest(buffer: Uint8Array): { request: HttpRequest; length: number } | 'incomplete' | { error: number } {
  const end = headerEnd(buffer);
  if (end < 0) return buffer.length > MAX_HEADERS ? { error: 431 } : 'incomplete';
  const lines = latin1(buffer.subarray(0, end)).split('\r\n');
  const start = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/.exec(lines[0] ?? '');
  if (start === null) return { error: 400 };
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: 400 };
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  if (headers.has('transfer-encoding')) return { error: 411 };
  const lengthText = headers.get('content-length') ?? '0';
  if (!/^\d+$/.test(lengthText)) return { error: 400 };
  const length = Number(lengthText);
  if (length > MAX_BODY) return { error: 413 };
  const bodyStart = end + 4;
  if (buffer.length < bodyStart + length) return 'incomplete';
  const target = start[2];
  const q = target.indexOf('?');
  return {
    request: { method: start[1], path: q < 0 ? target : target.slice(0, q), query: q < 0 ? '' : target.slice(q + 1), version: start[3], headers, body: buffer.slice(bodyStart, bodyStart + length) },
    length: bodyStart + length,
  };
}

function headerEnd(b: Uint8Array): number {
  for (let i = 0; i + 3 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  return -1;
}

function latin1(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]);
  return out;
}

/** UTF-8 bytes (no TextEncoder in the DOM-free typings). */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** UTF-8 text (invalid sequences become U+FFFD). */
export function utf8String(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; ) {
    const x = b[i];
    const n = x < 0x80 ? 1 : x >= 0xc2 && x < 0xe0 ? 2 : x >= 0xe0 && x < 0xf0 ? 3 : x >= 0xf0 && x < 0xf5 ? 4 : 0;
    if (n === 0 || i + n > b.length) {
      out += '�';
      i++;
      continue;
    }
    let c = n === 1 ? x : x & (0xff >> (n + 1));
    let ok = true;
    for (let k = 1; k < n; k++) {
      if ((b[i + k] & 0xc0) !== 0x80) ok = false;
      c = (c << 6) | (b[i + k] & 63);
    }
    out += ok ? String.fromCodePoint(c) : '�';
    i += ok ? n : 1;
  }
  return out;
}

export interface HttpLogEntry {
  /** Bench time, ns. */
  at: number;
  client: number;
  method: string;
  path: string;
  status: number;
  /** Response body bytes. */
  bytes: number;
}

/** A response: status line, Content-Type and Content-Length, Connection: close, the body. */
export function httpResponse(status: number, type: string, body: Uint8Array, head = false): Uint8Array {
  const reason = REASONS[status] ?? 'Status';
  const header = utf8Bytes(`HTTP/1.1 ${status} ${reason}\r\nServer: benchtop\r\nContent-Type: ${type}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
  if (head || status === 204 || status === 304) return header;
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}

export class HttpServer {
  readonly host: IpHost;
  readonly port: number;
  routes: HttpRoute[];
  /** Requests answered, oldest first (the newest LOG_SIZE). */
  readonly log: HttpLogEntry[] = [];
  count = 0;
  /** Runs after each response (the part's view). */
  onrequest: ((entry: HttpLogEntry) => void) | null = null;

  constructor(host: IpHost, port: number, routes: HttpRoute[]) {
    this.host = host;
    this.port = port;
    this.routes = routes;
    host.listenTcp(port, (connection) => this.accept(connection));
  }

  private accept(connection: TcpConnection): void {
    let buffer = new Uint8Array(0);
    let answered = false;
    connection.ondata = (data) => {
      if (answered) return;
      const next = new Uint8Array(buffer.length + data.length);
      next.set(buffer);
      next.set(data, buffer.length);
      buffer = next;
      const parsed = parseRequest(buffer);
      if (parsed === 'incomplete') return;
      answered = true;
      if ('error' in parsed) {
        connection.send(httpResponse(parsed.error, 'text/plain', utf8Bytes(`${REASONS[parsed.error] ?? 'Error'}\n`)));
        connection.close();
        return;
      }
      connection.send(this.respond(parsed.request, connection.remoteIp));
      connection.close();
    };
    // A client that closes without a full request gets nothing; one that sent it gets its answer first.
    connection.onpeerclose = () => {
      if (!answered) connection.close();
    };
  }

  /** The response to `request` from `client` (logged). */
  respond(request: HttpRequest, client: number): Uint8Array {
    this.count++;
    const head = request.method === 'HEAD';
    const asked = head ? 'GET' : request.method;
    const matches = (route: HttpRoute): boolean => (route.path.endsWith('*') ? request.path.startsWith(route.path.slice(0, -1)) : route.path === request.path);
    const onPath = this.routes.filter(matches);
    const route = onPath.find((r) => r.method === '*' || r.method === asked || r.method === request.method);
    let status = 404;
    let type = 'text/plain';
    let body = 'Not Found\n';
    if (route !== undefined) {
      status = route.status;
      type = route.type;
      body = this.fill(route.body, request, client);
    } else if (onPath.length > 0) {
      status = 405;
      body = 'Method Not Allowed\n';
    }
    const bytes = utf8Bytes(body);
    const entry: HttpLogEntry = { at: this.host.clock.now(), client, method: request.method, path: request.path, status, bytes: head ? 0 : bytes.length };
    this.log.push(entry);
    if (this.log.length > LOG_SIZE) this.log.shift();
    this.onrequest?.(entry);
    return httpResponse(status, type, bytes, head);
  }

  private fill(template: string, request: HttpRequest, client: number): string {
    return template.replace(/\{\{(method|path|query|body|client|count|time)\}\}/g, (_, key: string) => {
      switch (key) {
        case 'method':
          return request.method;
        case 'path':
          return request.path;
        case 'query':
          return request.query;
        case 'body':
          return utf8String(request.body);
        case 'client':
          return ipString(client);
        case 'count':
          return String(this.count);
        default:
          return (this.host.clock.now() / 1e9).toFixed(3);
      }
    });
  }
}

export interface HttpResult {
  status: number;
  headers: Map<string, string>;
  body: Uint8Array;
}

/**
 * A request from `host` to `ip`:`port` (BT100's tools): connects, sends, reads to the close (or
 * Content-Length), and calls `done` with the response — or with an error string (refused, reset,
 * timed out, not HTTP).
 */
export function httpRequest(host: IpHost, ip: number, port: number, request: { method: string; path: string; headers?: Record<string, string>; body?: Uint8Array }, done: (result: HttpResult | string) => void): void {
  const body = request.body ?? new Uint8Array(0);
  const lines = [`${request.method} ${request.path} HTTP/1.1`, `Host: ${ipString(ip)}${port === 80 ? '' : `:${port}`}`, 'Connection: close', 'User-Agent: benchtop'];
  for (const [name, value] of Object.entries(request.headers ?? {})) lines.push(`${name}: ${value}`);
  if (body.length > 0 || request.method === 'POST' || request.method === 'PUT') lines.push(`Content-Length: ${body.length}`);
  const head = utf8Bytes(`${lines.join('\r\n')}\r\n\r\n`);
  let buffer = new Uint8Array(0);
  let finished = false;
  const finish = (result: HttpResult | string): void => {
    if (finished) return;
    finished = true;
    done(result);
  };
  const connection = host.connectTcp(ip, port);
  connection.onopen = () => {
    const out = new Uint8Array(head.length + body.length);
    out.set(head);
    out.set(body, head.length);
    connection.send(out);
  };
  const tryParse = (closed: boolean): void => {
    const end = headerEnd(buffer);
    if (end < 0) {
      if (closed) finish('not an HTTP response');
      return;
    }
    const lines = latin1(buffer.subarray(0, end)).split('\r\n');
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '');
    if (status === null) {
      finish('not an HTTP response');
      return;
    }
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const length = headers.get('content-length');
    const rest = buffer.subarray(end + 4);
    if (length !== undefined && /^\d+$/.test(length) && rest.length >= Number(length)) {
      finish({ status: Number(status[1]), headers, body: rest.slice(0, Number(length)) });
      connection.close();
    } else if (closed) finish({ status: Number(status[1]), headers, body: rest.slice() });
  };
  connection.ondata = (data) => {
    const next = new Uint8Array(buffer.length + data.length);
    next.set(buffer);
    next.set(data, buffer.length);
    buffer = next;
    tryParse(false);
  };
  connection.onpeerclose = () => {
    tryParse(true);
    connection.close();
  };
  connection.onend = (why) => {
    if (why === 'reset') finish(buffer.length === 0 ? 'connection refused or reset' : 'connection reset');
    else if (why === 'timeout') finish('timed out');
    else tryParse(true);
  };
}
