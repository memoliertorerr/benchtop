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
