import { describe, expect, it } from 'vitest';
import { HidDecoder, type HidLayout, hidBits, parseHidReports } from './usb-hid.ts';
import { UsbLog } from './usb-log.ts';

// BT138: HID report descriptors (HID 1.11 §6.2.2) and what the host makes of the reports. The
// composite descriptor below is written here from the spec's items: a keyboard (report ID 1), a
// mouse with a wheel and horizontal pan (2), consumer control (3), system control (4) and a
// gamepad with a hat switch (5).

const KEYBOARD = [
  0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x85, 0x01, // Generic Desktop, Keyboard, Application, ID 1
  0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, // modifiers
  0x95, 0x01, 0x75, 0x08, 0x81, 0x01, // reserved byte
  0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00, // six keys (array)
  0xc0,
];
const MOUSE = [
  0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0x09, 0x01, 0xa1, 0x00, 0x85, 0x02, // Mouse, Application; Pointer, Physical; ID 2
  0x05, 0x09, 0x19, 0x01, 0x29, 0x05, 0x15, 0x00, 0x25, 0x01, 0x95, 0x05, 0x75, 0x01, 0x81, 0x02, // 5 buttons
  0x95, 0x01, 0x75, 0x03, 0x81, 0x01, // padding
  0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x09, 0x38, 0x15, 0x81, 0x25, 0x7f, 0x75, 0x08, 0x95, 0x03, 0x81, 0x06, // X, Y, wheel: relative
  0x05, 0x0c, 0x0a, 0x38, 0x02, 0x95, 0x01, 0x81, 0x06, // AC Pan
  0xc0, 0xc0,
];
const CONSUMER = [0x05, 0x0c, 0x09, 0x01, 0xa1, 0x01, 0x85, 0x03, 0x15, 0x00, 0x26, 0xff, 0x03, 0x19, 0x00, 0x2a, 0xff, 0x03, 0x75, 0x10, 0x95, 0x01, 0x81, 0x00, 0xc0];
const SYSTEM = [0x05, 0x01, 0x09, 0x80, 0xa1, 0x01, 0x85, 0x04, 0x19, 0x81, 0x29, 0x83, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x03, 0x81, 0x02, 0x95, 0x05, 0x81, 0x01, 0xc0];
const GAMEPAD = [
  0x05, 0x01, 0x09, 0x05, 0xa1, 0x01, 0x85, 0x05,
  0x09, 0x30, 0x09, 0x31, 0x15, 0x81, 0x25, 0x7f, 0x75, 0x08, 0x95, 0x02, 0x81, 0x02, // X, Y
  0x09, 0x39, 0x15, 0x01, 0x25, 0x08, 0x35, 0x00, 0x46, 0x3b, 0x01, 0x65, 0x14, 0x75, 0x04, 0x95, 0x01, 0x81, 0x42, // hat, null state
  0x75, 0x04, 0x95, 0x01, 0x81, 0x01, // padding
  0x05, 0x09, 0x19, 0x01, 0x29, 0x08, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, // 8 buttons
  0xc0,
];
const COMPOSITE = new Uint8Array([...KEYBOARD, ...MOUSE, ...CONSUMER, ...SYSTEM, ...GAMEPAD]);

function decoder(descriptor: Uint8Array) {
  const layout = parseHidReports(descriptor);
  if (typeof layout === 'string') throw new Error(layout);
  const log = new UsbLog(() => 1.5);
  const hid = new HidDecoder(layout, log);
  const send = (...bytes: number[]) => hid.report(new Uint8Array(bytes), bytes.length);
  const lines = () => log.events.map((e) => e.text);
  return { layout, log, hid, send, lines };
}

describe('HID report descriptors (BT138)', () => {
  it('a composite descriptor: each report by ID, what it is by its application collection, its size', () => {
    const layout = parseHidReports(COMPOSITE) as HidLayout;
    expect(layout.ids).toBe(true);
    expect(layout.reports.map((r) => [r.id, r.kind, r.bytes])).toEqual([
      [1, 'keyboard', 8],
      [2, 'mouse', 5],
      [3, 'consumer', 2],
      [4, 'system', 1],
      [5, 'gamepad', 4],
    ]);
    const keys = layout.reports[0].fields;
    expect(keys.map((f) => [f.bit, f.size, f.count, f.array, f.constant])).toEqual([
      [0, 1, 8, false, false],
      [8, 8, 1, true, true],
      [16, 8, 6, true, false],
    ]);
    expect(keys[0].usages[0]).toBe(0x700e0);
    expect([keys[2].usageMin, keys[2].usageMax, keys[2].logicalMax]).toEqual([0x70000, 0x70065, 0x65]);
    const mouse = layout.reports[1].fields;
    expect(mouse[2]).toMatchObject({ bit: 8, size: 8, count: 3, relative: true, logicalMin: -127, logicalMax: 127, usages: [0x10030, 0x10031, 0x10038] });
    expect(mouse[3].usages).toEqual([0xc0238]); // a 2-byte usage on the consumer page
    expect(layout.reports[2].fields[0]).toMatchObject({ size: 16, array: true, logicalMax: 0x3ff });
  });

  it('no report IDs: the boot keyboard; a vendor collection is "other"; the output report is skipped', () => {
    const boot = parseHidReports(new Uint8Array([0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, 0x95, 0x05, 0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x91, 0x02, 0x95, 0x06, 0x75, 0x08, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00, 0xc0])) as HidLayout;
    expect(boot.ids).toBe(false);
    expect(boot.reports.map((r) => [r.id, r.kind, r.bytes])).toEqual([[0, 'keyboard', 7]]);
    const vendor = parseHidReports(new Uint8Array([0x06, 0x00, 0xff, 0x09, 0x01, 0xa1, 0x01, 0x15, 0x00, 0x26, 0xff, 0x00, 0x75, 0x08, 0x95, 0x40, 0x09, 0x01, 0x81, 0x02, 0xc0])) as HidLayout;
    expect(vendor.reports.map((r) => [r.kind, r.bytes])).toEqual([['other', 64]]);
  });

  it('refuses broken descriptors without throwing: truncated, unbalanced, report ID 0, too deep, a pop without a push, too long', () => {
    expect(parseHidReports(new Uint8Array([0x05]))).toBe('truncated item at byte 0');
    expect(parseHidReports(new Uint8Array([0xc0]))).toBe('an end of collection without a collection');
    expect(parseHidReports(new Uint8Array([0xa1, 0x01]))).toBe('a collection left open');
    expect(parseHidReports(new Uint8Array([0x85, 0x00]))).toBe('report ID 0');
    expect(parseHidReports(new Uint8Array(new Array(17).fill([0xa1, 0x00]).flat()))).toBe('collections nested deeper than 16');
    expect(parseHidReports(new Uint8Array([0xb4]))).toBe('a pop without a push');
    expect(parseHidReports(new Uint8Array(5000))).toBe('report descriptor of 5000 bytes (at most 4096)');
    expect(parseHidReports(new Uint8Array([0x75, 0x08, 0x95, 0xff, 0x96, 0xff, 0x7f, 0x81, 0x02]))).toBe('report 0 too large');
    expect(parseHidReports(new Uint8Array([0xfe, 0x02, 0x10, 0xaa, 0xbb]))).toEqual({ ids: false, reports: [] }); // a long item, skipped
  });

  it('bits LSB first, across bytes, sign-extended when the range is signed', () => {
    const data = new Uint8Array([0xff, 0b1010_0000, 0x01]);
    expect(hidBits(data, 0, 0, 8, false)).toBe(255);
    expect(hidBits(data, 0, 0, 8, true)).toBe(-1);
    expect(hidBits(data, 0, 13, 4, false)).toBe(0b1101);
    expect(hidBits(data, 1, 4, 4, true)).toBe(-6);
  });
});

describe('HID reports as a computer sees them (BT138)', () => {
  it('keyboard: text with Shift and Caps Lock, held keys once, Enter, Backspace, named keys and chords', () => {
    const { send, log } = decoder(COMPOSITE);
    send(1, 0x02, 0, 0x0b, 0, 0, 0, 0, 0); // Shift+h
    send(1, 0x00, 0, 0x0c, 0, 0, 0, 0, 0); // i
    send(1, 0x00, 0, 0x0c, 0, 0, 0, 0, 0); // i still held
    send(1, 0x00, 0, 0x0c, 0x1e, 0, 0, 0, 0); // and 1
    send(1, 0x20, 0, 0x1e, 0x38, 0, 0, 0, 0); // right Shift and ?, 1 still held: not typed again
    send(1, 0, 0, 0, 0, 0, 0, 0, 0);
    send(1, 0x20, 0, 0x1e, 0, 0, 0, 0, 0); // right Shift and 1: !
    send(1, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(log.typed).toBe('Hi1?!');
    send(1, 0, 0, 0x39, 0, 0, 0, 0, 0); // Caps Lock
    send(1, 0, 0, 0x04, 0, 0, 0, 0, 0);
    send(1, 0x02, 0, 0x05, 0, 0, 0, 0, 0); // Shift with Caps Lock: lower case
    send(1, 0, 0, 0x39, 0, 0, 0, 0, 0);
    send(1, 0, 0, 0x2a, 0, 0, 0, 0, 0); // Backspace
    send(1, 0, 0, 0x28, 0, 0, 0, 0, 0);
    send(1, 0, 0, 0x3a, 0, 0, 0, 0, 0); // F1
    send(1, 0x01, 0, 0x06, 0, 0, 0, 0, 0); // Ctrl+C
    send(1, 0x05, 0, 0x4c, 0, 0, 0, 0, 0); // Ctrl+Alt+Del
    send(1, 0x08, 0, 0x1f, 0, 0, 0, 0, 0); // GUI+2
    send(1, 0, 0, 0x52, 0x2c, 0x2d, 0x59, 0x2b, 0); // Up, space, -, keypad 1, Tab
    expect(log.typed).toBe('Hi1?!A\n[F1][Ctrl+C][Ctrl+Alt+Del][GUI+2][Up] -1\t');
    expect(log.events).toEqual([]);
  });

  it('mouse: buttons down and up, moves merged into one line while it keeps moving, the wheel and pan', () => {
    const { send, lines } = decoder(COMPOSITE);
    send(2, 0x01, 20, 0xf6, 0, 0);
    send(2, 0x01, 5, 0, 0, 0);
    send(2, 0x00, 0, 0, 0, 0);
    send(2, 0x00, 0, 0, 1, 0);
    send(2, 0x00, 0xff, 0, 0, 0xfe);
    expect(lines()).toEqual(['mouse: left down', 'mouse: moved +25 -10', 'mouse: left up', 'mouse: wheel +1', 'mouse: moved -1 +0', 'mouse: pan -2']);
  });

  it('media and system keys as they go down; a gamepad’s buttons and axes', () => {
    const { send, lines } = decoder(COMPOSITE);
    send(3, 0xe9, 0x00);
    send(3, 0xe9, 0x00);
    send(3, 0x00, 0x00);
    send(3, 0x23, 0x02); // AC Home
    send(4, 0b010);
    send(5, 10, 0xf6, 0x03, 0x01);
    send(5, 12, 0xf6, 0x03, 0x01);
    send(5, 12, 0xf6, 0x00, 0x00);
    expect(lines()).toEqual(['media: Volume Up', 'media: Home', 'system: Sleep', 'gamepad: button 1 down', 'gamepad: X 12 Y -10 hat right', 'gamepad: button 1 up', 'gamepad: X 12 Y -10 hat centered']);
  });

  it('reports too short, or with an ID it doesn’t know, are ignored; events carry the clock', () => {
    const { send, log } = decoder(COMPOSITE);
    send(1, 0x02, 0, 0x0b);
    send(9, 1, 2, 3);
    send();
    expect(log.typed).toBe('');
    send(3, 0xe2, 0);
    expect(log.events).toEqual([{ at: 1.5, text: 'media: Mute', key: '' }]);
  });
});
