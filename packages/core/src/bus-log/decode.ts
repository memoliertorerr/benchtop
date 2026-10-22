/**
 * Bus records → transactions (BT86), incrementally: records arrive in chunks (a frame's worth)
 * and a transaction may span chunks, so `BusDecoder` keeps each source's open transaction.
 * - I2C: a START opens one (address, R/W, the device's ACK); bytes follow with their ACKs; STOP
 *   closes it, and a repeated START closes it and opens the next.
 * - SPI: CS falling opens a frame, CS rising closes it; transfers outside a frame (CS tied low,
 *   or the log starting mid-frame) group by gaps of more than SPI_GAP_NS.
 * - UART: bytes group into bursts, a gap longer than two byte-times at the port's baud (1 ms when
 *   the baud is unknown) ending one.
 * A transaction keeps its first MAX_BYTES bytes (a TFT's frame is ~150 KB) and counts them all.
 * The worker, the MCP server and the spec runner share this.
 */

import type { Nanos } from '../contracts/time.ts';
import { BUS, type BusRecords, type BusSource } from './log.ts';

/** Bytes a transaction keeps (it counts the rest). */
export const MAX_BYTES = 4096;
/** Transfers outside a CS frame further apart than this start a new one. */
export const SPI_GAP_NS = 100_000;
/** A UART burst ends after this when the baud is unknown. */
const UART_DEFAULT_GAP_NS = 1_000_000;

interface Base {
  /** The source's id (`BusLog.sources`). */
  source: number;
  /** First and last record's time, ns. */
  t: Nanos;
  end: Nanos;
  /** Bytes in the transaction (the arrays hold the first MAX_BYTES). */
  count: number;
}

export interface I2cTransaction extends Base {
  bus: 'i2c';
  /** 7-bit address (-1: the log started after the START). */
  address: number;
  read: boolean;
  /** The device ACKed its address. */
  ack: boolean;
  bytes: number[];
  /** Per byte: written — the device ACKed; read — the controller ACKed (false: the last one). */
  acks: boolean[];
  /** It ended with a repeated START rather than a STOP. */
  restarted: boolean;
}

export interface SpiTransaction extends Base {
  bus: 'spi';
  mosi: number[];
  miso: number[];
  /** Framed by the device's chip select (false: grouped by time). */
  framed: boolean;
}

export interface UartTransaction extends Base {
  bus: 'uart';
  bytes: number[];
}

export type BusTransaction = I2cTransaction | SpiTransaction | UartTransaction;

export class BusDecoder {
  private readonly open = new Map<number, BusTransaction>();

  /** Feeds a chunk of records; returns the transactions they completed, in order. */
  feed(records: BusRecords, sources: readonly BusSource[]): BusTransaction[] {
    const done: BusTransaction[] = [];
    const n = records.times.length;
    for (let i = 0; i < n; i++) {
      const t = records.times[i];
      const kind = records.kinds[i];
      const source = records.sources[i];
      const a = records.a[i];
      const b = records.b[i];
      const current = this.open.get(source);
      switch (kind) {
        case BUS.I2C_START: {
          if (current?.bus === 'i2c') {
            current.restarted = true;
            this.close(source, done);
          }
          this.open.set(source, { bus: 'i2c', source, t, end: t, count: 0, address: a & 0x7f, read: (a & 0x80) !== 0, ack: b === 1, bytes: [], acks: [], restarted: false });
          break;
        }
        case BUS.I2C_WRITE:
        case BUS.I2C_READ: {
          let tx = current?.bus === 'i2c' ? current : undefined;
          if (tx === undefined) {
            tx = { bus: 'i2c', source, t, end: t, count: 0, address: -1, read: kind === BUS.I2C_READ, ack: true, bytes: [], acks: [], restarted: false };
            this.open.set(source, tx);
          }
          tx.end = t;
          if (tx.count++ < MAX_BYTES) {
            tx.bytes.push(a);
            tx.acks.push(b === 1);
          }
          break;
        }
        case BUS.I2C_STOP:
          if (current?.bus === 'i2c') {
            current.end = t;
            this.close(source, done);
          }
          break;
        case BUS.SPI_SELECT:
          if (current !== undefined) this.close(source, done);
          this.open.set(source, { bus: 'spi', source, t, end: t, count: 0, mosi: [], miso: [], framed: true });
          break;
        case BUS.SPI_XFER: {
          let tx = current?.bus === 'spi' ? current : undefined;
          if (tx !== undefined && !tx.framed && t - tx.end > SPI_GAP_NS) {
            this.close(source, done);
            tx = undefined;
          }
          if (tx === undefined) {
            tx = { bus: 'spi', source, t, end: t, count: 0, mosi: [], miso: [], framed: false };
            this.open.set(source, tx);
          }
          tx.end = t;
          if (tx.count++ < MAX_BYTES) {
            tx.mosi.push(a);
            tx.miso.push(b);
          }
          break;
        }
        case BUS.SPI_DESELECT:
          if (current?.bus === 'spi') {
            current.end = t;
            this.close(source, done);
          }
          break;
        case BUS.UART_TX:
        case BUS.UART_RX: {
          let tx = current?.bus === 'uart' ? current : undefined;
          if (tx !== undefined && t - tx.end > uartGap(sources[source])) {
            this.close(source, done);
            tx = undefined;
          }
          if (tx === undefined) {
            tx = { bus: 'uart', source, t, end: t, count: 0, bytes: [] };
            this.open.set(source, tx);
          }
          tx.end = t;
          if (tx.count++ < MAX_BYTES) tx.bytes.push(a);
          break;
        }
      }
    }
    return done;
  }

  /** Closes what time alone ends — UART bursts and unframed SPI quiet since before `now`. */
  flush(now: Nanos, sources: readonly BusSource[]): BusTransaction[] {
    const done: BusTransaction[] = [];
    for (const [source, tx] of [...this.open]) {
      if (tx.bus === 'uart' && now - tx.end > uartGap(sources[source])) this.close(source, done);
      else if (tx.bus === 'spi' && !tx.framed && now - tx.end > SPI_GAP_NS) this.close(source, done);
    }
    return done;
  }

  /** Transactions still open, oldest first. */
  pending(): BusTransaction[] {
    return [...this.open.values()].sort((x, y) => x.t - y.t);
  }

  /** Forgets everything open (a new log). */
  reset(): void {
    this.open.clear();
  }

  private close(source: number, done: BusTransaction[]): void {
    const tx = this.open.get(source);
    if (tx === undefined) return;
    this.open.delete(source);
    done.push(tx);
  }
}

function uartGap(source: BusSource | undefined): number {
  const baud = source?.baud?.() ?? 0;
  return baud > 0 ? (2 * 10 * 1e9) / baud : UART_DEFAULT_GAP_NS;
}

/** One line for people: "12.345 ms  lcd1 (I2C 0x27)  W 08 0C 08". */
export function describeTransaction(tx: BusTransaction, sources: readonly BusSource[]): string {
  const hex = (bytes: readonly number[]): string => bytes.map((v) => v.toString(16).padStart(2, '0')).join(' ');
  const more = (shown: number): string => (tx.count > shown ? ` …(+${tx.count - shown})` : '');
  const label = sources[tx.source]?.label ?? `source ${tx.source}`;
  const at = `${(tx.t / 1e6).toFixed(3)} ms`;
  if (tx.bus === 'i2c') {
    const address = tx.address < 0 ? '?' : `0x${tx.address.toString(16).padStart(2, '0')}`;
    const nacks = tx.acks.filter((ack, i) => !ack && !(tx.read && i === tx.acks.length - 1)).length;
    return `${at}  ${label}  ${tx.read ? 'R' : 'W'} ${address}${tx.ack ? '' : ' NACK'}  ${hex(tx.bytes)}${more(tx.bytes.length)}${nacks > 0 ? `  (${nacks} NACK)` : ''}`;
  }
  if (tx.bus === 'spi') return `${at}  ${label}  MOSI ${hex(tx.mosi)}${more(tx.mosi.length)}  MISO ${hex(tx.miso)}`;
  const text = tx.bytes.map((v) => (v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : v === 10 ? '\\n' : v === 13 ? '\\r' : `\\x${v.toString(16).padStart(2, '0')}`)).join('');
  return `${at}  ${label}  "${text}"${more(tx.bytes.length)}`;
}
