import { connect, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodePacket, RspDecoder } from '@benchtop/avr';
import { parseElf32, SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { startGdbServer } from './gdb.ts';

// The GDB stub over TCP (BT26): a scripted RSP client against startGdbServer() on port 0.

const io = { readFile: (path: string) => readFileSync(resolve(REPO_ROOT, path)), now: () => performance.now() };
const ELF = 'fixtures/firmware/uno/debug-demo.elf';
const addSlow = SymbolTable.fromElf(parseElf32(io.readFile(ELF))).lookup('addSlow')!.address;

/** A minimal RSP client: sends packets, acks and collects replies. */
class Client {
  readonly socket: Socket;
  readonly closed: Promise<void>;
  private readonly decoder = new RspDecoder();
  private readonly replies: string[] = [];
  private waiter: ((data: string) => void) | null = null;

  constructor(socket: Socket) {
    this.socket = socket;
    this.closed = new Promise((resolve) => socket.once('close', () => resolve()));
    socket.on('data', (chunk: Buffer) => {
      for (const event of this.decoder.feed(chunk)) {
        if (event.type !== 'packet') continue;
        socket.write('+');
        if (this.waiter !== null) {
          const w = this.waiter;
          this.waiter = null;
          w(event.data);
        } else this.replies.push(event.data);
      }
    });
  }

  static open(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => resolve(new Client(socket)));
      socket.once('error', reject);
    });
  }

  /** The next reply packet (timing out after `ms`). */
  next(ms = 2000): Promise<string> {
    const queued = this.replies.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no reply')), ms);
      this.waiter = (data) => {
        clearTimeout(timer);
        resolve(data);
      };
    });
  }

  ask(data: string, ms?: number): Promise<string> {
    this.socket.write(encodePacket(data));
    return this.next(ms);
  }
}

const pcOf = (g: string): number => Number.parseInt(g.slice(70, 72), 16) | (Number.parseInt(g.slice(72, 74), 16) << 8);
const hex = (n: number): string => n.toString(16);

describe('benchtop gdb', () => {
  it('serves a scripted session: breakpoints, continue, step, interrupt, kill and a new client (also one that reconnects at once)', async () => {
    const transcript: string[] = [];
    const server = await startGdbServer({
      project: 'fixtures/projects/debug-demo.json',
      firmware: { uno: ELF },
      port: 0,
      io,
      log: (direction, packet) => transcript.push(`${direction === 'recv' ? '→' : '←'} ${packet.length > 90 ? `${packet.slice(0, 90)}…` : packet}`),
    });
    try {
      expect(server.address).toBe('127.0.0.1');
      const client = await Client.open(server.port);
      expect(await client.ask('qSupported:multiprocess+;swbreak+;hwbreak+')).toContain('PacketSize');
      expect(await client.ask('?')).toBe('S05');
      expect(await client.ask(`Z0,${hex(addSlow)},2`)).toBe('OK');
      expect(await client.ask('c')).toBe('S05');
      expect(pcOf(await client.ask('g'))).toBe(addSlow);
      expect(await client.ask('s')).toBe('S05');
      expect(pcOf(await client.ask('g'))).toBe(addSlow + 2); // movw r26, r24: one 2-byte instruction
      expect(await client.ask(`z0,${hex(addSlow)},2`)).toBe('OK');

      client.socket.write(encodePacket('c'));
      await new Promise((r) => setTimeout(r, 100));
      const sent = performance.now();
      client.socket.write(Uint8Array.of(0x03));
      expect(await client.next()).toBe('S02');
      const latency = performance.now() - sent;
      expect(latency).toBeLessThan(200);

      expect(await client.ask('vCont?')).toBe('vCont;c;C;s;S');
      expect(await client.ask('qSomethingNew')).toBe('');
      client.socket.write(encodePacket('k'));
      await client.closed;

      const again = await Client.open(server.port);
      expect(await again.ask('qSupported')).toContain('PacketSize');
      expect(pcOf(await again.ask('g'))).toBe(0); // k reset the MCU
      // Kill and reconnect at once, before the old socket has closed (gdb does this after
      // `kill`): the server freed its one-client slot at k, so the new client is served.
      again.socket.write(encodePacket('k'));
      const third = await Client.open(server.port);
      expect(await third.ask('qSupported')).toContain('PacketSize');
      third.socket.end();
      await third.closed;
      console.info(`gdb session transcript (interrupt answered in ${latency.toFixed(1)} ms):\n${transcript.join('\n')}`);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('closes a second concurrent client at once', async () => {
    const server = await startGdbServer({ project: 'fixtures/projects/debug-demo.json', firmware: { uno: ELF }, port: 0, io });
    try {
      const first = await Client.open(server.port);
      expect(await first.ask('?')).toBe('S05');
      const second = await Client.open(server.port);
      const start = performance.now();
      await second.closed;
      expect(performance.now() - start).toBeLessThan(500);
      expect(await first.ask('?')).toBe('S05'); // the first one is unaffected
      first.socket.end();
      await first.closed;
    } finally {
      await server.close();
    }
  });
});
