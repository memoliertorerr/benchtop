/**
 * A GDB Remote Serial Protocol command dispatcher for one connection (DOM-free). The transport
 * (apps/cli's gdb command, or a test) feeds it bytes with `receive` and gives it a `GdbControl`
 * that runs the bench; while the target runs, the transport calls `stopped(reason)` when it
 * stops (a breakpoint, or the 0x03 interrupt the session forwarded).
 *
 * Commands: qSupported, QStartNoAckMode, ?, g, G, m, M, c/s [addr], C/S sig[;addr], vCont? and
 * vCont;c/s (thread ids ignored), Z0/z0 (software breakpoints through McuDebug — never BREAK in
 * flash: avr8js ignores it), qAttached, qC, qfThreadInfo/qsThreadInfo, Hg/Hc, k (reset and
 * close), D (OK, close, stay paused). Anything else gets an empty reply. Stop replies: S05
 * breakpoint or step, S02 interrupt, S04 MCU fault.
 */

import { encodePacket, RspDecoder } from './rsp.ts';
import { AvrGdbTarget } from './target.ts';
import type { McuDebug } from '@benchtop/core';

export type GdbStopReason = 'breakpoint' | 'step' | 'interrupt' | 'fault';

export interface GdbControl {
  readonly debug: McuDebug;
  /** Start running; call `session.stopped()` when the target stops. */
  continue(): void;
  /** The client sent 0x03 while running: stop, then call `session.stopped('interrupt')`. */
  interrupt(): void;
  /** Exactly one instruction (keeping the bench in time); 'fault' if the MCU faulted. */
  step(): 'step' | 'fault';
  /** `k`: reset the MCU (the bench). */
  reset(): void;
  /** `k` and `D`: close this connection after anything already written. */
  close(): void;
}

export const SUPPORTED = 'PacketSize=1000;QStartNoAckMode+';
export const VCONT_ACTIONS = 'vCont;c;C;s;S';

const STOP_REPLY: Record<GdbStopReason, string> = { breakpoint: 'S05', step: 'S05', interrupt: 'S02', fault: 'S04' };

export class GdbSession {
  private readonly control: GdbControl;
  private readonly target: AvrGdbTarget;
  private readonly write: (bytes: string) => void;
  private readonly log: ((direction: 'recv' | 'send', packet: string) => void) | undefined;
  private readonly decoder = new RspDecoder();
  private noAck = false;
  private lastSent = '';
  /** Whether the target is running (between a continue and its stop reply). */
  running = false;

  /** `write` sends raw bytes as a binary string (one char per byte). */
  constructor(control: GdbControl, write: (bytes: string) => void, log?: (direction: 'recv' | 'send', packet: string) => void) {
    this.control = control;
    this.target = new AvrGdbTarget(control.debug);
    this.write = write;
    this.log = log;
  }

  receive(chunk: Uint8Array): void {
    for (const event of this.decoder.feed(chunk)) {
      switch (event.type) {
        case 'interrupt':
          this.log?.('recv', '\\x03');
          if (this.running) this.control.interrupt();
          break;
        case 'bad':
          if (!this.noAck) this.write('-');
          break;
        case 'nack':
          if (!this.noAck && this.lastSent !== '') this.write(this.lastSent);
          break;
        case 'ack':
          break;
        case 'packet': {
          this.log?.('recv', event.data);
          if (!this.noAck) this.write('+');
          const reply = this.command(event.data);
          if (reply !== null) this.reply(reply);
          if (event.data === 'QStartNoAckMode') this.noAck = true;
          break;
        }
      }
    }
  }

  /** The target stopped after a continue. */
  stopped(reason: GdbStopReason): void {
    this.running = false;
    this.reply(STOP_REPLY[reason]);
  }

  private reply(data: string): void {
    this.log?.('send', data);
    this.lastSent = encodePacket(data);
    this.write(this.lastSent);
  }

  /** One command's reply; null when there is none yet (the target runs) or the link closes. */
  command(data: string): string | null {
    if (data.startsWith('qSupported')) return SUPPORTED;
    if (data === 'QStartNoAckMode') return 'OK';
    if (data === '?') return 'S05';
    if (data === 'g') return this.target.readRegisters();
    if (data[0] === 'G') return this.target.writeRegisters(data.slice(1)) ? 'OK' : 'E01';
    if (data[0] === 'm') {
      const m = /^m([0-9a-fA-F]+),([0-9a-fA-F]+)$/.exec(data);
      const hex = m === null ? undefined : this.target.readMemory(Number.parseInt(m[1], 16), Number.parseInt(m[2], 16));
      return hex ?? 'E01';
    }
    if (data[0] === 'M') {
      const m = /^M([0-9a-fA-F]+),([0-9a-fA-F]+):([0-9a-fA-F]*)$/.exec(data);
      return m !== null && this.target.writeMemory(Number.parseInt(m[1], 16), Number.parseInt(m[2], 16), m[3]) ? 'OK' : 'E01';
    }
    if (data === 'vCont?') return VCONT_ACTIONS;
    if (data.startsWith('vCont;')) {
      // The first action applies to our one thread: c, Cxx, s or Sxx, with an optional :tid.
      const action = data.slice(6).split(';')[0].split(':')[0];
      if (action === 'c' || /^C[0-9a-fA-F]{2}$/.test(action)) return this.resume(undefined);
      if (action === 's' || /^S[0-9a-fA-F]{2}$/.test(action)) return this.stepOnce(undefined);
      return 'E01';
    }
    const resume = /^([csCS])([0-9a-fA-F]*)(?:;([0-9a-fA-F]+))?$/.exec(data);
    if (resume !== null) {
      // c/s [addr]; C/S sig[;addr] (the signal is ignored).
      const lower = resume[1] === 'c' || resume[1] === 's';
      const addressText = lower ? resume[2] : resume[3];
      const address = addressText === undefined || addressText === '' ? undefined : Number.parseInt(addressText, 16);
      return resume[1].toLowerCase() === 'c' ? this.resume(address) : this.stepOnce(address);
    }
    const breakpoint = /^([Zz])([0-4]),([0-9a-fA-F]+),([0-9a-fA-F]+)$/.exec(data);
    if (breakpoint !== null) {
      if (breakpoint[2] !== '0') return ''; // hardware breakpoints and watchpoints: not supported
      const address = Number.parseInt(breakpoint[3], 16);
      try {
        if (breakpoint[1] === 'Z') this.control.debug.setBreakpoint(address);
        else this.control.debug.clearBreakpoint(address);
        return 'OK';
      } catch {
        return 'E01';
      }
    }
    if (data === 'qAttached' || data.startsWith('qAttached:')) return '1';
    if (data === 'qC') return 'QC1';
    if (data === 'qfThreadInfo') return 'm1';
    if (data === 'qsThreadInfo') return 'l';
    if (data[0] === 'H' && (data[1] === 'g' || data[1] === 'c')) return 'OK';
    if (data === 'k') {
      this.running = false;
      this.control.reset();
      this.control.close();
      return null;
    }
    if (data === 'D' || data.startsWith('D;')) {
      this.running = false;
      this.reply('OK');
      this.control.close();
      return null;
    }
    return '';
  }

  private resume(address: number | undefined): string | null {
    if (address !== undefined) this.target.pc = address;
    this.running = true;
    this.control.continue();
    return null;
  }

  private stepOnce(address: number | undefined): string {
    if (address !== undefined) this.target.pc = address;
    return STOP_REPLY[this.control.step()];
  }
}
