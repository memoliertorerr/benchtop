/**
 * TCP for the virtual LAN's TypeScript hosts (BT99; RFC 9293, the part a lossless, in-order link
 * needs). A connection opens actively (`IpHost.connectTcp`) or passively (a listener's accept),
 * carries bytes both ways and closes with FIN (either side first) or RST.
 *
 * Sending: bytes queue, and go out in segments of at most the peer's MSS (its SYN's option, 536
 * without one, never past 1460) while what is in flight stays within the window the peer
 * advertises; an ACK frees the window and sends more (lwIP on an ESP32 advertises 5744 bytes).
 * The LAN loses nothing, but a station can drop a frame (its driver's queue, lwIP out of
 * buffers), so unacknowledged data — and an unanswered SYN or FIN — goes again after 1 s
 * (go-back-N from the oldest unacknowledged byte), five times at most before the connection is
 * reset. Receiving: data in order is delivered at once (`ondata`) and ACKed at once, with a
 * 65535-byte window (it's never full: nothing waits to be read); a duplicate is ACKed again and
 * dropped; data past a gap (never on this LAN) is dropped with an ACK for what's expected. No
 * options but MSS, no urgent data, no TIME_WAIT (a closed connection is forgotten at once: the
 * LAN delivers no stray old segments).
 */

import { be16, be32, checksum, pseudoSum, PROTO_TCP, setBe16, setBe32 } from './packet.ts';
import type { LanClock } from './lan.ts';

export const TCP = { FIN: 1, SYN: 2, RST: 4, PSH: 8, ACK: 16 } as const;
const HEADER = 20;
const WINDOW = 65535;
const DEFAULT_MSS = 536;
const MAX_MSS = 1460;
const RTO_NS = 1_000_000_000;
const MAX_RETRIES = 5;

export interface TcpSegment {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: number;
  window: number;
  /** The MSS option (SYN segments), or 0. */
  mss: number;
  data: Uint8Array;
}

/** A segment from `src` to `dst` (for the checksum), with an MSS option when `mss` is given. */
export function tcpSegment(src: number, dst: number, s: { srcPort: number; dstPort: number; seq: number; ack: number; flags: number; window: number; mss?: number; data?: Uint8Array }): Uint8Array {
  const options = s.mss === undefined ? 0 : 4;
  const data = s.data ?? new Uint8Array(0);
  const p = new Uint8Array(HEADER + options + data.length);
  setBe16(p, 0, s.srcPort);
  setBe16(p, 2, s.dstPort);
  setBe32(p, 4, s.seq >>> 0);
  setBe32(p, 8, s.ack >>> 0);
  p[12] = ((HEADER + options) / 4) << 4;
  p[13] = s.flags;
  setBe16(p, 14, s.window);
  if (s.mss !== undefined) {
    p[20] = 2;
    p[21] = 4;
    setBe16(p, 22, s.mss);
  }
  p.set(data, HEADER + options);
  setBe16(p, 16, checksum(p, 0, p.length, pseudoSum(src, dst, PROTO_TCP, p.length)));
  return p;
}

/** A segment with a correct checksum and header length, or undefined. */
export function parseTcp(src: number, dst: number, p: Uint8Array): TcpSegment | undefined {
  if (p.length < HEADER) return undefined;
  const offset = (p[12] >> 4) * 4;
  if (offset < HEADER || offset > p.length || checksum(p, 0, p.length, pseudoSum(src, dst, PROTO_TCP, p.length)) !== 0) return undefined;
  let mss = 0;
  for (let i = HEADER; i < offset; ) {
    const kind = p[i];
    if (kind === 0) break;
    if (kind === 1) {
      i++;
      continue;
    }
    if (i + 1 >= offset || p[i + 1] < 2 || i + p[i + 1] > offset) break;
    if (kind === 2 && p[i + 1] === 4) mss = be16(p, i + 2);
    i += p[i + 1];
  }
  return { srcPort: be16(p, 0), dstPort: be16(p, 2), seq: be32(p, 4), ack: be32(p, 8), flags: p[13], window: be16(p, 14), mss, data: p.subarray(offset) };
}

export type TcpState = 'syn-sent' | 'syn-received' | 'established' | 'fin-wait-1' | 'fin-wait-2' | 'close-wait' | 'closing' | 'last-ack' | 'closed';

/** Why a connection ended: both sides closed, the peer reset it, or it gave up (no answer). */
export type TcpEnd = 'closed' | 'reset' | 'timeout';

/** What a connection needs from its host. */
export interface TcpOwner {
  readonly clock: LanClock;
  /** Sends a segment (already built) to the peer. */
  output(remoteIp: number, segment: Uint8Array): void;
  readonly ip: number;
  /** Forgets the connection (closed). */
  forget(connection: TcpConnection): void;
}

/** Sequence arithmetic: a − b as a signed 32-bit difference. */
const diff = (a: number, b: number): number => (a - b) | 0;

export class TcpConnection {
  readonly localPort: number;
  readonly remoteIp: number;
  readonly remotePort: number;
  state: TcpState;
  /** Bytes in order from the peer. */
  ondata: ((data: Uint8Array) => void) | null = null;
  /** Established (both opens). */
  onopen: (() => void) | null = null;
  /** The peer sent FIN: it sends no more (we may still send, then close). */
  onpeerclose: (() => void) | null = null;
  /** The connection is gone. */
  onend: ((why: TcpEnd) => void) | null = null;
  /** Bytes received and sent. */
  received = 0;
  sent = 0;
  private readonly owner: TcpOwner;
  private readonly iss: number;
  private sndUna: number;
  private sndNxt: number;
  private sndWnd = 0;
  private mss = DEFAULT_MSS;
  private rcvNxt = 0;
  /** Bytes from sndUna on: sent and unacknowledged, then not yet sent. */
  private buffer = new Uint8Array(0);
  private closeAsked = false;
  private finSent = false;
  private retries = 0;
  private timer = 0;

  constructor(owner: TcpOwner, localPort: number, remoteIp: number, remotePort: number, iss: number, state: TcpState) {
    this.owner = owner;
    this.localPort = localPort;
    this.remoteIp = remoteIp >>> 0;
    this.remotePort = remotePort;
    this.iss = iss >>> 0;
    this.sndUna = this.iss;
    this.sndNxt = this.iss;
    this.state = state;
  }

  /** Active open: sends SYN. */
  open(): void {
    this.sndNxt = (this.iss + 1) >>> 0;
    this.emit(this.iss, 0, TCP.SYN, MAX_MSS);
    this.arm();
  }

  /** Passive open: the peer's SYN; answers SYN-ACK. */
  accept(syn: TcpSegment): void {
    this.rcvNxt = (syn.seq + 1) >>> 0;
    this.sndWnd = syn.window;
    this.mss = Math.min(MAX_MSS, syn.mss || DEFAULT_MSS);
    this.sndNxt = (this.iss + 1) >>> 0;
    this.emit(this.iss, this.rcvNxt, TCP.SYN | TCP.ACK, MAX_MSS);
    this.arm();
  }

  send(data: Uint8Array): void {
    if (this.closeAsked || this.state === 'closed' || data.length === 0) return;
    const next = new Uint8Array(this.buffer.length + data.length);
    next.set(this.buffer);
    next.set(data, this.buffer.length);
    this.buffer = next;
    this.flush();
  }

  /** FIN once everything queued has gone. */
  close(): void {
    if (this.closeAsked || this.state === 'closed') return;
    this.closeAsked = true;
    if (this.state === 'syn-sent') {
      this.end('closed');
      return;
    }
    this.flush();
  }

  /** RST now. */
  abort(): void {
    this.reset('reset');
  }

  private reset(why: TcpEnd): void {
    if (this.state === 'closed') return;
    if (this.state !== 'syn-sent') this.emit(this.sndNxt, this.rcvNxt, TCP.RST | TCP.ACK);
    this.end(why);
  }

  /** A segment for this connection, from the host. */
  segment(seg: TcpSegment): void {
    if (this.state === 'closed') return;
    if ((seg.flags & TCP.RST) !== 0) {
      this.end('reset');
      return;
    }
    if (this.state === 'syn-sent') {
      if ((seg.flags & (TCP.SYN | TCP.ACK)) !== (TCP.SYN | TCP.ACK) || seg.ack !== this.sndNxt) {
        this.emit(seg.ack, 0, TCP.RST);
        return;
      }
      this.rcvNxt = (seg.seq + 1) >>> 0;
      this.sndUna = seg.ack;
      this.sndWnd = seg.window;
      this.mss = Math.min(MAX_MSS, seg.mss || DEFAULT_MSS);
      this.state = 'established';
      this.retries = 0;
      this.emit(this.sndNxt, this.rcvNxt, TCP.ACK);
      this.onopen?.();
      this.flush();
      return;
    }
    if ((seg.flags & TCP.SYN) !== 0) {
      // Our SYN-ACK was lost and the SYN came again, or a stray: answer with where we are.
      this.emit(this.state === 'syn-received' ? this.iss : this.sndNxt, this.rcvNxt, this.state === 'syn-received' ? TCP.SYN | TCP.ACK : TCP.ACK, this.state === 'syn-received' ? MAX_MSS : undefined);
      return;
    }
    if ((seg.flags & TCP.ACK) === 0) return;
    this.acknowledge(seg);
    if (this.isClosed()) return;
    // Data and FIN, in order only.
    const fin = (seg.flags & TCP.FIN) !== 0;
    if (seg.data.length > 0 || fin) {
      const offset = diff(this.rcvNxt, seg.seq);
      if (offset < 0 || offset > seg.data.length) {
        this.emit(this.sndNxt, this.rcvNxt, TCP.ACK); // a gap: say what we expect
        return;
      }
      const fresh = seg.data.subarray(offset);
      const finFresh = fin && offset <= seg.data.length && !this.peerClosed();
      if (fresh.length > 0 && (this.state === 'established' || this.state === 'fin-wait-1' || this.state === 'fin-wait-2')) {
        this.rcvNxt = (this.rcvNxt + fresh.length) >>> 0;
        this.received += fresh.length;
        this.ondata?.(fresh);
      }
      if (finFresh) {
        this.rcvNxt = (this.rcvNxt + 1) >>> 0;
        this.peerFin();
      }
      if (!this.isClosed()) this.emit(this.sndNxt, this.rcvNxt, TCP.ACK);
    }
  }

  /** A method, not a field test: a callback may have closed the connection meanwhile. */
  private isClosed(): boolean {
    return this.state === 'closed';
  }

  private peerClosed(): boolean {
    return this.state === 'close-wait' || this.state === 'closing' || this.state === 'last-ack';
  }

  private peerFin(): void {
    switch (this.state) {
      case 'established':
        this.state = 'close-wait';
        this.onpeerclose?.();
        break;
      case 'fin-wait-1':
        this.state = 'closing';
        this.onpeerclose?.();
        break;
      case 'fin-wait-2':
        this.onpeerclose?.();
        this.emit(this.sndNxt, this.rcvNxt, TCP.ACK);
        this.end('closed');
        break;
      default:
    }
  }

  private acknowledge(seg: TcpSegment): void {
    const acked = diff(seg.ack, this.sndUna);
    if (acked < 0 || diff(seg.ack, this.sndNxt) > 0) return; // old, or for what we never sent
    this.sndWnd = seg.window;
    if (acked > 0) {
      // A SYN or FIN takes one sequence number: count only the data.
      let bytes = acked;
      if (this.state === 'syn-received' && diff(this.sndUna, this.iss) === 0) {
        bytes--;
        this.state = 'established';
        this.onopen?.();
      }
      const finAcked = this.finSent && seg.ack === this.sndNxt;
      if (finAcked) bytes--;
      bytes = Math.max(0, Math.min(bytes, this.buffer.length));
      this.buffer = this.buffer.subarray(bytes);
      this.sndUna = seg.ack;
      this.retries = 0;
      if (finAcked) {
        if (this.state === 'fin-wait-1') this.state = 'fin-wait-2';
        else if (this.state === 'closing' || this.state === 'last-ack') {
          this.end('closed');
          return;
        }
      }
    }
    if (this.sndUna === this.sndNxt) this.disarm();
    else this.arm();
    this.flush();
  }

  /** Sends what the window allows, then FIN when asked and everything is out. */
  private flush(): void {
    if (this.state !== 'established' && this.state !== 'close-wait') return;
    for (;;) {
      const inFlight = diff(this.sndNxt, this.sndUna);
      const unsent = this.buffer.length - inFlight;
      const room = this.sndWnd - inFlight;
      if (unsent <= 0 || room <= 0) break;
      const n = Math.min(unsent, room, this.mss);
      const chunk = this.buffer.subarray(inFlight, inFlight + n);
      this.emit(this.sndNxt, this.rcvNxt, TCP.ACK | TCP.PSH, undefined, chunk);
      this.sndNxt = (this.sndNxt + n) >>> 0;
      this.sent += n;
      this.arm();
    }
    if (this.closeAsked && !this.finSent && diff(this.sndNxt, this.sndUna) === this.buffer.length) {
      this.finSent = true;
      this.emit(this.sndNxt, this.rcvNxt, TCP.FIN | TCP.ACK);
      this.sndNxt = (this.sndNxt + 1) >>> 0;
      this.state = this.state === 'close-wait' ? 'last-ack' : 'fin-wait-1';
      this.arm();
    }
  }

  private emit(seq: number, ack: number, flags: number, mss?: number, data?: Uint8Array): void {
    const s = { srcPort: this.localPort, dstPort: this.remotePort, seq, ack, flags, window: WINDOW, ...(mss === undefined ? {} : { mss }), ...(data === undefined ? {} : { data }) };
    this.owner.output(this.remoteIp, tcpSegment(this.owner.ip, this.remoteIp, s));
  }

  /** (Re)starts the retransmission timer. */
  private arm(): void {
    const token = ++this.timer;
    this.owner.clock.schedule(this.owner.clock.now() + RTO_NS, () => {
      if (token === this.timer) this.timeout();
    });
  }

  private disarm(): void {
    this.timer++;
  }

  /** Nothing acknowledged for an RTO: everything from sndUna again (go-back-N). */
  private timeout(): void {
    if (this.state === 'closed') return;
    if (++this.retries > MAX_RETRIES) {
      this.reset('timeout');
      return;
    }
    if (this.state === 'syn-sent') {
      this.emit(this.iss, 0, TCP.SYN, MAX_MSS);
      this.arm();
      return;
    }
    if (this.state === 'syn-received') {
      this.emit(this.iss, this.rcvNxt, TCP.SYN | TCP.ACK, MAX_MSS);
      this.arm();
      return;
    }
    const finWasSent = this.finSent;
    this.sndNxt = this.sndUna;
    this.finSent = false;
    if (finWasSent) this.state = this.state === 'last-ack' || this.state === 'closing' ? 'close-wait' : 'established';
    this.flush();
  }

  private end(why: TcpEnd): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.disarm();
    this.owner.forget(this);
    this.onend?.(why);
  }
}
