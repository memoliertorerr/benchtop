/**
 * USB-MIDI on the bench's host (BT138), written from the USB Device Class Definition for MIDI
 * Devices 1.0 (§4: 32-bit USB-MIDI event packets — cable number and Code Index Number, then up to
 * three MIDI bytes) and the MIDI 1.0 message formats. Chip-neutral, DOM-free.
 *
 * Each packet becomes an event in the host's `UsbLog`: "MIDI: note on ch 1 C4 (60) velocity 100"
 * (a note on with velocity 0 is a note off), note off, polyphonic and channel pressure, control
 * change, program change, pitch bend (−8192…8191), SysEx gathered across packets (its bytes in
 * hex, the first 32), the system common and real-time messages by name. A stream of one
 * controller, pressure or pitch bend on one channel merges into one line. Timing clock (0xF8) and
 * active sensing (0xFE) are counted, not logged.
 *
 * BT145: `encodeMidi` goes the other way, for the host's MIDI to the device.
 */

import type { UsbLog } from './usb-log.ts';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SYSEX_SHOWN = 32;
const SYSEX_KEPT = 4096;
const REALTIME: ReadonlyMap<number, string> = new Map([
  [0xfa, 'start'],
  [0xfb, 'continue'],
  [0xfc, 'stop'],
  [0xff, 'reset'],
  [0xf6, 'tune request'],
]);

/** "C4 (60)": middle C is C4. */
export function noteName(note: number): string {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1} (${note})`;
}

const hex = (b: number): string => b.toString(16).toUpperCase().padStart(2, '0');

export class MidiDecoder {
  /** Timing clocks (0xF8) and active sensing (0xFE) seen: too many to log. */
  clocks = 0;
  private readonly log: UsbLog;
  /** SysEx bytes gathered so far (per cable 0 only: one stream at a time). */
  private sysex: number[] = [];

  constructor(log: UsbLog) {
    this.log = log;
  }

  /** The 4-byte event packet at `data[at]`. */
  packet(data: Uint8Array, at: number): void {
    const header = data[at];
    const cin = header & 0x0f;
    const cable = header >> 4;
    const b1 = data[at + 1];
    const b2 = data[at + 2];
    const b3 = data[at + 3];
    const prefix = cable === 0 ? 'MIDI:' : `MIDI cable ${cable}:`;
    switch (cin) {
      case 0x4: // SysEx starts or continues
        this.gather(b1, b2, b3);
        return;
      case 0x5: // a single-byte system common message, or SysEx ending with one byte
        if (b1 === 0xf7 || this.sysex.length > 0) {
          this.gather(b1);
          this.endSysex(prefix);
        } else this.system(prefix, b1, 1, 0, 0);
        return;
      case 0x6:
        this.gather(b1, b2);
        this.endSysex(prefix);
        return;
      case 0x7:
        this.gather(b1, b2, b3);
        this.endSysex(prefix);
        return;
      case 0x2:
        this.system(prefix, b1, 2, b2, 0);
        return;
      case 0x3:
        this.system(prefix, b1, 3, b2, b3);
        return;
      case 0xf:
        this.system(prefix, b1, 1, 0, 0);
        return;
      default:
    }
    if (cin < 0x8) return; // 0x0, 0x1: reserved
    const ch = (b1 & 0x0f) + 1;
    switch (b1 & 0xf0) {
      case 0x90:
        if (b3 !== 0) {
          this.log.event(`${prefix} note on ch ${ch} ${noteName(b2)} velocity ${b3}`);
          return;
        }
        this.log.event(`${prefix} note off ch ${ch} ${noteName(b2)}`);
        return;
      case 0x80:
        this.log.event(`${prefix} note off ch ${ch} ${noteName(b2)}`);
        return;
      case 0xa0:
        this.log.event(`${prefix} poly pressure ch ${ch} ${noteName(b2)} ${b3}`, `midi-pp ${cable} ${ch} ${b2}`);
        return;
      case 0xb0:
        this.log.event(`${prefix} control change ch ${ch} #${b2} = ${b3}`, `midi-cc ${cable} ${ch} ${b2}`);
        return;
      case 0xc0:
        this.log.event(`${prefix} program change ch ${ch} → ${b2}`);
        return;
      case 0xd0:
        this.log.event(`${prefix} channel pressure ch ${ch} ${b2}`, `midi-cp ${cable} ${ch}`);
        return;
      case 0xe0: {
        const bend = ((b3 << 7) | b2) - 8192;
        this.log.event(`${prefix} pitch bend ch ${ch} ${bend >= 0 ? '+' : ''}${bend}`, `midi-pb ${cable} ${ch}`);
        return;
      }
      default:
    }
  }

  private gather(...bytes: number[]): void {
    for (const b of bytes) if (this.sysex.length < SYSEX_KEPT) this.sysex.push(b);
  }

  private endSysex(prefix: string): void {
    const bytes = this.sysex;
    this.sysex = [];
    const shown = bytes.slice(0, SYSEX_SHOWN).map(hex).join(' ');
    this.log.event(`${prefix} SysEx ${shown}${bytes.length > SYSEX_SHOWN ? ' …' : ''} (${bytes.length} bytes)`);
  }

  /** System common and real-time messages (`length` bytes from `status`). */
  private system(prefix: string, status: number, length: number, a: number, b: number): void {
    if (status === 0xf8 || status === 0xfe) {
      this.clocks++;
      return;
    }
    const name = REALTIME.get(status);
    if (name !== undefined) {
      this.log.event(`${prefix} ${name}`);
      return;
    }
    if (status === 0xf2) this.log.event(`${prefix} song position ${(b << 7) | a}`);
    else if (status === 0xf3) this.log.event(`${prefix} song select ${a}`);
    else if (status === 0xf1) this.log.event(`${prefix} time code ${hex(a)}`, `midi-mtc ${prefix}`);
    else this.log.event(`${prefix} ${[status, a, b].slice(0, length).map(hex).join(' ')}`);
  }
}

// ── Host to device (BT145) ──────────────────────────────────────────────────────────────

/** Data bytes after a channel voice status (by its high nibble), or after a system common one. */
const CHANNEL_DATA: Readonly<Record<number, number>> = { 0x8: 2, 0x9: 2, 0xa: 2, 0xb: 2, 0xc: 1, 0xd: 1, 0xe: 2 };
const COMMON_DATA: Readonly<Record<number, number>> = { 0xf1: 1, 0xf2: 2, 0xf3: 1, 0xf6: 0 };

/**
 * Whole MIDI 1.0 messages → USB-MIDI event packets on cable 0 (4 bytes each), or why not:
 * channel voice messages (CIN = the status's high nibble), system common (CIN 2 or 3 by length,
 * 5 for a lone byte), real-time bytes (CIN 0xF) and SysEx (F0 … F7: CIN 4 per 3 bytes, the last
 * packet 5, 6 or 7 by how many bytes it ends with). No running status: each message carries its
 * status byte.
 */
export function encodeMidi(bytes: Uint8Array): Uint8Array | string {
  const out: number[] = [];
  const at = (i: number): string => `byte ${i + 1} (${hex(bytes[i])})`;
  for (let i = 0; i < bytes.length; ) {
    const status = bytes[i];
    if (status < 0x80) return `${at(i)} is a data byte without a status (each message needs its own)`;
    if (status >= 0xf8) {
      out.push(0x0f, status, 0, 0);
      i++;
      continue;
    }
    if (status === 0xf0) {
      let end = i + 1;
      while (end < bytes.length && bytes[end] < 0x80) end++;
      if (end >= bytes.length || bytes[end] !== 0xf7) return `the SysEx at ${at(i)} doesn't end with F7`;
      const length = end - i + 1;
      for (let k = 0; k < length; k += 3) {
        const left = length - k;
        const cin = left > 3 ? 0x4 : 0x4 + left;
        out.push(cin, bytes[i + k], left > 1 ? bytes[i + k + 1] : 0, left > 2 ? bytes[i + k + 2] : 0);
      }
      i = end + 1;
      continue;
    }
    const data = status < 0xf0 ? CHANNEL_DATA[status >> 4] : COMMON_DATA[status];
    if (data === undefined) return `${at(i)} isn't a message MIDI 1.0 defines`;
    for (let k = 1; k <= data; k++) if (bytes[i + k] === undefined || bytes[i + k] >= 0x80) return `the message at ${at(i)} needs ${data} data byte${data === 1 ? '' : 's'}`;
    const cin = status < 0xf0 ? status >> 4 : data === 0 ? 0x5 : data === 1 ? 0x2 : 0x3;
    out.push(cin, status, data > 0 ? bytes[i + 1] : 0, data > 1 ? bytes[i + 2] : 0);
    i += 1 + data;
  }
  return new Uint8Array(out);
}
