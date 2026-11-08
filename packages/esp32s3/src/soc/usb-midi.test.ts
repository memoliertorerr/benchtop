import { describe, expect, it } from 'vitest';
import { MidiDecoder, noteName } from './usb-midi.ts';
import { UsbLog } from './usb-log.ts';

// BT138: USB-MIDI 1.0 event packets (cable number, Code Index Number, three MIDI bytes) as the
// host's log lines.

function midi() {
  const log = new UsbLog(() => 0);
  const decoder = new MidiDecoder(log);
  const send = (...packets: number[][]) => {
    const bytes = new Uint8Array(packets.flat());
    for (let at = 0; at + 4 <= bytes.length; at += 4) decoder.packet(bytes, at);
  };
  return { log, decoder, send, lines: () => log.events.map((e) => e.text) };
}

describe('USB-MIDI packets (BT138)', () => {
  it('notes on and off (velocity 0 is off), pressures, program change, pitch bend', () => {
    const { send, lines } = midi();
    send([0x09, 0x90, 60, 100], [0x09, 0x90, 60, 0], [0x08, 0x83, 64, 40], [0x0a, 0xa0, 61, 20], [0x0c, 0xc1, 5, 0], [0x0d, 0xd0, 64, 0], [0x0e, 0xe0, 0, 0x40], [0x0e, 0xe0, 0x7f, 0x7f]);
    expect(lines()).toEqual([
      'MIDI: note on ch 1 C4 (60) velocity 100',
      'MIDI: note off ch 1 C4 (60)',
      'MIDI: note off ch 4 E4 (64)',
      'MIDI: poly pressure ch 1 C#4 (61) 20',
      'MIDI: program change ch 2 → 5',
      'MIDI: channel pressure ch 1 64',
      'MIDI: pitch bend ch 1 +8191', // the first bend (0) merged into the second
    ]);
    expect([noteName(0), noteName(21), noteName(127)]).toEqual(['C-1 (0)', 'A0 (21)', 'G9 (127)']);
  });

  it('a controller sweeping stays one line; another controller or channel starts a new one', () => {
    const { send, lines } = midi();
    send([0x0b, 0xb0, 7, 10], [0x0b, 0xb0, 7, 20], [0x0b, 0xb0, 7, 127], [0x0b, 0xb0, 10, 64], [0x0b, 0xb1, 10, 64]);
    expect(lines()).toEqual(['MIDI: control change ch 1 #7 = 127', 'MIDI: control change ch 1 #10 = 64', 'MIDI: control change ch 2 #10 = 64']);
  });

  it('SysEx gathered across packets; real-time messages by name, clocks counted; a second cable named', () => {
    const { send, lines, decoder } = midi();
    send([0x04, 0xf0, 0x7e, 0x7f], [0x04, 0x06, 0x01, 0x02], [0x06, 0x03, 0xf7, 0], [0x07, 0xf0, 0x01, 0xf7]);
    send([0x0f, 0xfa, 0, 0], [0x0f, 0xf8, 0, 0], [0x0f, 0xf8, 0, 0], [0x0f, 0xfe, 0, 0], [0x0f, 0xfc, 0, 0], [0x03, 0xf2, 0x10, 0x01], [0x19, 0x90, 48, 1], [0x00, 1, 2, 3]);
    expect(lines()).toEqual([
      'MIDI: SysEx F0 7E 7F 06 01 02 03 F7 (8 bytes)',
      'MIDI: SysEx F0 01 F7 (3 bytes)',
      'MIDI: start',
      'MIDI: stop',
      'MIDI: song position 144',
      'MIDI cable 1: note on ch 1 C3 (48) velocity 1',
    ]);
    expect(decoder.clocks).toBe(3);
  });
});

describe('the host’s log (BT138)', () => {
  it('keeps the last 4 KB typed and the last 256 events, counting what it dropped', () => {
    const log = new UsbLog(() => 0);
    log.type('x'.repeat(5000));
    log.type('yz');
    expect(log.typed.length).toBe(4096);
    expect(log.typed.endsWith('xyz')).toBe(true);
    log.backspace();
    expect(log.typed.endsWith('xy')).toBe(true);
    for (let i = 0; i < 300; i++) log.event(`e${i}`);
    expect(log.events.length).toBe(256);
    expect(log.events[0].text).toBe('e44');
    expect(log.dropped).toBe(44);
  });
});
