/**
 * The CLI uplink's socket thread (BT101, uplink.ts): opens the TCP connections the main thread
 * asks for (already checked against `--network`) and reports what happens to each. Nothing
 * listens; a connection idle for 60 s is closed.
 */

import { connect, type Socket } from 'node:net';
import { type MessagePort, workerData } from 'node:worker_threads';
import type { UplinkCommand, UplinkReply } from './uplink.ts';

const IDLE_MS = 60_000;
const { port, redirect } = workerData as { port: MessagePort; redirect: Record<string, string> };
const sockets = new Map<number, Socket>();
const reply = (message: UplinkReply): void => port.postMessage(message);

port.on('message', (command: UplinkCommand) => {
  if (command.type === 'open') {
    const target = redirect[`${command.host}:${command.port}`];
    const colon = target === undefined ? -1 : target.lastIndexOf(':');
    const host = target === undefined ? command.host : target.slice(0, colon);
    const to = target === undefined ? command.port : Number(target.slice(colon + 1));
    const socket = connect({ host, port: to });
    sockets.set(command.id, socket);
    socket.setNoDelay(true);
    socket.setTimeout(IDLE_MS, () => socket.destroy(new Error('idle for 60 s')));
    let error: string | null = null;
    socket.on('connect', () => reply({ type: 'opened', id: command.id }));
    socket.on('data', (chunk: Buffer) => reply({ type: 'data', id: command.id, bytes: new Uint8Array(chunk) }));
    socket.on('error', (e) => (error = e.message));
    socket.on('close', () => {
      if (sockets.get(command.id) !== socket) return;
      sockets.delete(command.id);
      reply({ type: 'closed', id: command.id, error });
    });
    return;
  }
  const socket = sockets.get(command.id);
  if (socket === undefined) return;
  if (command.type === 'send') socket.write(command.bytes);
  else if (command.type === 'end') socket.end();
  else {
    sockets.delete(command.id);
    socket.destroy();
  }
});
