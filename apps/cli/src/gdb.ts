/**
 * `benchtop gdb`: a GDB Remote Serial Protocol server for one board of a bench, so avr-gdb (or
 * any RSP client) can debug it:
 *   npm run bench -- gdb [--port 3333] [--speed realtime|max] [--board uno] <project.json>
 *       --firmware uno=<file.elf>
 * It listens on 127.0.0.1 only, never 0.0.0.0, one client at a time (a second one is closed at
 * once). While the client continues, the bench runs in 1 ms simulated slices — paced in real
 * time by default, flat out with --speed max — yielding with setImmediate between slices so a
 * 0x03 interrupt byte is read promptly. The protocol itself is @benchtop/avr's GdbSession.
 */

import { createServer, type Socket } from 'node:net';
import { type GdbControl, GdbSession } from '@benchtop/avr';
import { NS_PER_MS, RealtimePacer } from '@benchtop/core';
import { buildBench, type CliIo, loadFirmware, loadProject, UsageError } from './load.ts';

export interface GdbServerOptions {
  project: string;
  firmware: Readonly<Record<string, string>>;
  /** 0 picks a free port. */
  port: number;
  speed?: 'realtime' | 'max';
  /** The board to debug; default: the first one with a debugger. */
  board?: string | undefined;
  io: CliIo;
  /** Every packet received and sent (a transcript). */
  log?: (direction: 'recv' | 'send', packet: string) => void;
}

export interface GdbServer {
  port: number;
  address: string;
  board: string;
  close(): Promise<void>;
}

const SLICE_NS = NS_PER_MS;

export async function startGdbServer(options: GdbServerOptions): Promise<GdbServer> {
  const { doc, boards } = loadProject(options.io, options.project);
  const images = loadFirmware(options.io, doc, boards, options.firmware);
  const { bench } = buildBench(doc, images, options.io.esp32Rom?.(), options.io.micropython?.());
  const board = options.board ?? boards.find((b) => bench.debugOf(b) !== undefined);
  if (board === undefined || !boards.includes(board)) throw new UsageError(options.board === undefined ? 'no board with a debugger in the project' : `no board "${options.board}"`);
  const debug = bench.debugOf(board);
  if (debug === undefined) throw new UsageError(`the MCU on "${board}" has no debugger`);
  const realtime = options.speed !== 'max';

  let active: Socket | null = null;
  const server = createServer((socket) => {
    if (active !== null) {
      socket.destroy(); // one client at a time
      return;
    }
    active = socket;
    socket.setNoDelay(true);
    let running = false;
    let released = false;
    /**
     * This client is done (k, D, or its connection closed): free the one-client slot and drop its
     * breakpoints, once. Done at k/D time, not only on 'close' — a client that reconnects at
     * once (gdb after `kill`) arrives before the old socket's 'close' event and was refused.
     */
    const release = (): void => {
      running = false;
      if (released) return;
      released = true;
      for (const address of debug.breakpoints()) debug.clearBreakpoint(address);
      if (active === socket) active = null;
    };
    const pacer = new RealtimePacer(realtime ? 1 : Number.POSITIVE_INFINITY);
    const stop = (reason: 'breakpoint' | 'interrupt' | 'fault'): void => {
      running = false;
      session.stopped(reason);
    };
    const slice = (): void => {
      if (!running) return;
      const now = performance.now();
      const target = pacer.target(now, bench.now());
      if (bench.now() < target) {
        const result = bench.runUntil(Math.min(target, bench.now() + SLICE_NS));
        if (result.reason === 'breakpoint') return stop('breakpoint');
        if (bench.mcuStopped(board)?.reason === 'fault') return stop('fault');
        setImmediate(slice);
      } else {
        setTimeout(slice, 1); // ahead of the wall clock (real-time pacing)
      }
    };
    const control: GdbControl = {
      debug,
      continue() {
        running = true;
        pacer.start(performance.now());
        setImmediate(slice);
      },
      interrupt() {
        if (running) stop('interrupt');
      },
      step() {
        bench.debugStep(board);
        return bench.mcuStopped(board)?.reason === 'fault' ? 'fault' : 'step';
      },
      reset() {
        running = false;
        bench.reset();
      },
      close() {
        release();
        socket.end();
      },
    };
    const session = new GdbSession(control, (data) => socket.write(Buffer.from(data, 'latin1')), options.log);
    socket.on('data', (chunk: Buffer) => session.receive(chunk));
    socket.on('error', () => {
      // a reset connection: 'close' follows
    });
    socket.on('close', release); // the next client starts without this one's breakpoints
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the GDB server has no TCP address');
  return {
    port: address.port,
    address: address.address,
    board,
    close: () =>
      new Promise<void>((resolve) => {
        (active as Socket | null)?.destroy();
        server.close(() => {
          bench.dispose();
          resolve();
        });
      }),
  };
}

/** `gdb` arguments: [--port n] [--speed realtime|max] [--board id] <project.json> --firmware <board>=<path>… */
export function parseGdbArgs(argv: readonly string[]): Omit<GdbServerOptions, 'io' | 'log'> {
  let project: string | undefined;
  const firmware: Record<string, string> = {};
  let port = 3333;
  let speed: 'realtime' | 'max' = 'realtime';
  let board: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    if (arg === '--port') {
      port = Number(value());
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port wants 0–65535');
    } else if (arg === '--speed') {
      const v = value();
      if (v !== 'realtime' && v !== 'max') throw new UsageError('--speed wants realtime or max');
      speed = v;
    } else if (arg === '--board') board = value();
    else if (arg === '--firmware') {
      const v = value();
      const eq = v.indexOf('=');
      if (eq <= 0 || eq === v.length - 1) throw new UsageError(`--firmware wants <board>=<path>, got "${v}"`);
      firmware[v.slice(0, eq)] = v.slice(eq + 1);
    } else if (arg.startsWith('--')) throw new UsageError(`unknown option ${arg}`);
    else if (project === undefined) project = arg;
    else throw new UsageError(`unexpected argument "${arg}"`);
  }
  if (project === undefined) throw new UsageError('no project file given');
  return { project, firmware, port, speed, board };
}
