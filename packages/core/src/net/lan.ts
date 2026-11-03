/**
 * A virtual LAN (BT98): one access point's network. Ports — the boards' WiFi stations
 * (wireless) and the access point's own hosts (wired to it: its gateway, later servers) — send
 * Ethernet II frames; the LAN hands each to the port its destination MAC names, or to every other
 * port for a broadcast or multicast, through the bench's scheduler.
 *
 * Timing: a frame's airtime is 100 µs plus its bits at 54 Mb/s (802.11g's top rate). A station
 * transmits one frame at a time (its own queue), and the access point relays to stations one
 * frame at a time (one queue for the AP's radio): a station's frame reaches a host when its
 * airtime ends, another station when the AP's relay of it ends; a host's frame reaches stations
 * through the AP's queue, other hosts at once (+1 µs). So frames between two ports arrive in the
 * order sent. No loss. Frames are read-only once sent (receivers may share them).
 */

import { type Mac, macIs } from './packet.ts';

export interface LanPort {
  readonly mac: Mac;
  /** A frame for this port, at the bench time it arrives. */
  deliver(frame: Uint8Array): void;
}

export interface LanClock {
  /** Bench time, ns (the sending MCU's own time while one runs). */
  now(): number;
  /** Runs `fn` at bench time `at`. */
  schedule(at: number, fn: () => void): void;
}

const HOP_NS = 100_000;
const NS_PER_BIT = 1e9 / 54e6;
const WIRED_NS = 1000;

interface Attached {
  port: LanPort;
  wireless: boolean;
  /** When this station's radio is free again (wireless ports). */
  airFree: number;
}

export class VirtualLan {
  /** Frames and bytes sent (each once, however many ports got it). */
  frames = 0;
  bytes = 0;
  readonly clock: LanClock;
  private readonly ports: Attached[] = [];
  /** When the access point's radio is free again. */
  private apFree = 0;

  constructor(clock: LanClock) {
    this.clock = clock;
  }

  attach(port: LanPort, wireless: boolean): void {
    if (!this.has(port)) this.ports.push({ port, wireless, airFree: 0 });
  }

  detach(port: LanPort): void {
    const i = this.ports.findIndex((p) => p.port === port);
    if (i >= 0) this.ports.splice(i, 1);
  }

  has(port: LanPort): boolean {
    return this.ports.some((p) => p.port === port);
  }

  /** The port with `mac`, or undefined. */
  portOf(mac: Mac): LanPort | undefined {
    return this.ports.find((p) => p.port.mac.every((b, i) => b === mac[i]))?.port;
  }

  send(from: LanPort, frame: Uint8Array): void {
    const sender = this.ports.find((p) => p.port === from);
    if (sender === undefined || frame.length < 14) return;
    this.frames++;
    this.bytes += frame.length;
    const group = (frame[0] & 1) !== 0;
    const air = HOP_NS + frame.length * 8 * NS_PER_BIT;
    const now = this.clock.now();
    let heard = now + WIRED_NS;
    if (sender.wireless) {
      const start = Math.max(now, sender.airFree);
      heard = start + air;
      sender.airFree = heard;
    }
    let relayed = -1;
    for (const target of this.ports) {
      if (target === sender || (!group && !macIs(frame, 0, target.port.mac))) continue;
      let at = heard;
      if (target.wireless) {
        if (relayed < 0) {
          relayed = Math.max(heard, this.apFree) + air;
          this.apFree = relayed;
        }
        at = relayed;
      }
      const port = target.port;
      this.clock.schedule(at, () => {
        // A port that left meanwhile (a station disconnected) gets nothing.
        if (this.has(port)) port.deliver(frame);
      });
    }
  }
}
