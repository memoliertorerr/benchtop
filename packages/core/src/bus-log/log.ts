/**
 * The bus log (BT86): every I2C, SPI and UART transaction the bench carries, as timestamped
 * records in one preallocated ring — parallel typed arrays, overwriting the oldest record when
 * full and counting the loss; `push` never allocates. The buses are transaction-level
 * (contracts/bus.ts), so the records are the calls the bench sees: an I2C device's start /
 * write / read / stop, an SPI device's chip-select edges and transfers, each byte a UART sends or
 * is handed. `decode.ts` groups them into transactions.
 *
 * Record fields by kind (`a`, `b`):
 * - I2C_START: a = 7-bit address | read << 7, b = 1 if the device ACKed
 * - I2C_WRITE: a = the byte, b = 1 if the device ACKed
 * - I2C_READ:  a = the byte, b = 1 if the controller ACKs it (more to come), 0 for the last
 * - I2C_STOP, SPI_SELECT, SPI_DESELECT: a = b = 0
 * - SPI_XFER:  a = MOSI, b = MISO
 * - UART_TX, UART_RX: a = the byte
 *
 * A source is one attachment (an I2C or SPI device on its controller) or one direction of one
 * board's UART port; the bench names them when it builds.
 */

import type { Nanos } from '../contracts/time.ts';

export const BUS = {
  I2C_START: 1,
  I2C_WRITE: 2,
  I2C_READ: 3,
  I2C_STOP: 4,
  SPI_SELECT: 5,
  SPI_DESELECT: 6,
  SPI_XFER: 7,
  UART_TX: 8,
  UART_RX: 9,
} as const;

/** Records a log holds before it overwrites the oldest. */
export const BUS_LOG_CAPACITY = 1 << 16;

export interface BusSource {
  readonly id: number;
  readonly bus: 'i2c' | 'spi' | 'uart';
  /** The board whose controller or port it is ('' until an I2C/SPI device is attached). */
  board: string;
  /** The device's part id (I2C, SPI), or null for a UART port. */
  readonly part: string | null;
  /** For people: "lcd1 (I2C 0x27)", "uno Serial TX". */
  label: string;
  /** UART: the port's baud now (0 if unknown); the decoder splits bursts at gaps measured in bytes. */
  baud?: () => number;
  /** UART: 'tx' (the board sends) or 'rx' (it is handed bytes). */
  readonly direction?: 'tx' | 'rx';
}

/** What `BusLog.read` copies out: records from absolute index `from` on. */
export interface BusRecords {
  from: number;
  times: Float64Array;
  kinds: Uint8Array;
  sources: Uint16Array;
  a: Uint16Array;
  b: Uint8Array;
  /** Records asked for that were overwritten (or beyond `max`). */
  lost: number;
}

export class BusLog {
  readonly capacity: number;
  private readonly time: Float64Array;
  private readonly kind: Uint8Array;
  private readonly source: Uint16Array;
  private readonly a: Uint16Array;
  private readonly b: Uint8Array;
  /** Records ever pushed: the absolute index of the next one. */
  written = 0;
  readonly sources: BusSource[] = [];
  /** Bumped whenever a source is added or renamed (readers resend the table). */
  version = 0;

  constructor(capacity = BUS_LOG_CAPACITY) {
    this.capacity = capacity;
    this.time = new Float64Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.source = new Uint16Array(capacity);
    this.a = new Uint16Array(capacity);
    this.b = new Uint8Array(capacity);
  }

  addSource(source: Omit<BusSource, 'id'>): BusSource {
    const added: BusSource = { ...source, id: this.sources.length };
    this.sources.push(added);
    this.version++;
    return added;
  }

  /** A source's board and label changed (an I2C/SPI device attached to a controller). */
  renamed(): void {
    this.version++;
  }

  push(time: Nanos, kind: number, source: number, a: number, b: number): void {
    const i = this.written % this.capacity;
    this.time[i] = time;
    this.kind[i] = kind;
    this.source[i] = source;
    this.a[i] = a;
    this.b[i] = b;
    this.written++;
  }

  /** Absolute index of the oldest record held. */
  get first(): number {
    return Math.max(0, this.written - this.capacity);
  }

  /** Copies the records from absolute index `since` on — at most `max`, the newest. */
  read(since: number, max = this.capacity): BusRecords {
    const end = this.written;
    let from = Math.max(since, this.first, end - max);
    if (from > end) from = end;
    const n = end - from;
    const out: BusRecords = {
      from,
      times: new Float64Array(n),
      kinds: new Uint8Array(n),
      sources: new Uint16Array(n),
      a: new Uint16Array(n),
      b: new Uint8Array(n),
      lost: Math.max(0, from - since),
    };
    for (let k = 0; k < n; k++) {
      const i = (from + k) % this.capacity;
      out.times[k] = this.time[i];
      out.kinds[k] = this.kind[i];
      out.sources[k] = this.source[i];
      out.a[k] = this.a[i];
      out.b[k] = this.b[i];
    }
    return out;
  }
}
