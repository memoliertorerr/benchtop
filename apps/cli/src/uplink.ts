/**
 * The CLI's real network (BT101): `--network host:port,…` lets a project's access point reach
 * those hosts (and only those it also lists itself). The bench runs synchronously, so sockets
 * live in a worker thread (uplink-worker.ts): commands go to it by message, and the bench's pump —
 * every simulated millisecond while a connection is open — takes what came back with
 * `receiveMessageOnPort`, then sleeps (`Atomics.wait`) while simulated time is ahead of the wall
 * clock since the first connection opened, so a firmware's timeouts meet real latencies.
 */

import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from 'node:worker_threads';
import { type AllowEntry, allows, type Uplink, type UplinkEvents, type UplinkSocket } from '@benchtop/core';

/** What the worker sends back. */
export type UplinkReply = { type: 'opened'; id: number } | { type: 'data'; id: number; bytes: Uint8Array } | { type: 'closed'; id: number; error: string | null };
/** What the worker is told. */
export type UplinkCommand = { type: 'open'; id: number; host: string; port: number } | { type: 'send'; id: number; bytes: Uint8Array } | { type: 'end'; id: number } | { type: 'close'; id: number };

export interface NodeUplinkOptions {
  /** The user's `--network` list. */
  allow: readonly AllowEntry[];
  /** Tests: `host:port` → `address:port` to connect to instead (a local server). */
  redirect?: Readonly<Record<string, string>>;
  /** Hold simulated time to the wall clock while a connection is open (default true). */
  pace?: boolean;
}

/** BT101: a run's uplink when `io` has a `--network` list, else undefined (nothing leaves the machine). */
export function uplinkFor(io: { network?: readonly AllowEntry[]; networkRedirect?: Readonly<Record<string, string>> }): NodeUplink | undefined {
  if (io.network === undefined || io.network.length === 0) return undefined;
  return new NodeUplink({ allow: io.network, ...(io.networkRedirect === undefined ? {} : { redirect: io.networkRedirect }) });
}

/** The longest a pump sleeps at once, ms. */
const MAX_SLEEP_MS = 50;

export class NodeUplink implements Uplink {
  private readonly allow: readonly AllowEntry[];
  private readonly pace: boolean;
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private readonly sockets = new Map<number, UplinkEvents>();
  /** Events decided here (a refusal), delivered at the next pump like the worker's. */
  private readonly local: UplinkReply[] = [];
  private nextId = 1;
  private readonly sleeper = new Int32Array(new SharedArrayBuffer(4));
  private anchor: { wall: number; sim: number } | null = null;

  constructor(options: NodeUplinkOptions) {
    this.allow = options.allow;
    this.pace = options.pace !== false;
    const { port1, port2 } = new MessageChannel();
    this.worker = new Worker(new URL('./uplink-worker.ts', import.meta.url), { workerData: { port: port2, redirect: options.redirect ?? {} }, transferList: [port2] });
    this.worker.unref();
    port1.unref();
    this.port = port1;
  }

  connect(host: string, port: number, events: UplinkEvents): UplinkSocket {
    const id = this.nextId++;
    this.sockets.set(id, events);
    if (allows(this.allow, host, port)) this.post({ type: 'open', id, host, port });
    else this.local.push({ type: 'closed', id, error: `${host}:${port} isn't on --network` });
    return {
      send: (bytes) => {
        if (this.sockets.has(id)) this.post({ type: 'send', id, bytes: bytes.slice() });
      },
      end: () => {
        if (this.sockets.has(id)) this.post({ type: 'end', id });
      },
      close: () => {
        if (this.sockets.delete(id)) this.post({ type: 'close', id });
      },
    };
  }

  pump(nowNs: number): void {
    for (const reply of this.local.splice(0)) this.handle(reply);
    for (;;) {
      const received = receiveMessageOnPort(this.port);
      if (received === undefined) break;
      this.handle(received.message as UplinkReply);
    }
    if (this.sockets.size === 0) {
      this.anchor = null;
      return;
    }
    if (!this.pace) return;
    const wall = performance.now();
    if (this.anchor === null) this.anchor = { wall, sim: nowNs };
    const ahead = (nowNs - this.anchor.sim) / 1e6 - (wall - this.anchor.wall);
    if (ahead > 0) Atomics.wait(this.sleeper, 0, 0, Math.min(ahead, MAX_SLEEP_MS));
  }

  /** Closes every socket and stops the worker. */
  dispose(): void {
    this.sockets.clear();
    void this.worker.terminate();
  }

  private post(command: UplinkCommand): void {
    this.port.postMessage(command);
  }

  private handle(reply: UplinkReply): void {
    const events = this.sockets.get(reply.id);
    if (events === undefined) return;
    if (reply.type === 'opened') events.opened();
    else if (reply.type === 'data') events.data(reply.bytes);
    else {
      this.sockets.delete(reply.id);
      events.closed(reply.error);
    }
  }
}
