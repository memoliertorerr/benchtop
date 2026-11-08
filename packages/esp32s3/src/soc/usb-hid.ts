/**
 * USB HID on the bench's host (BT138), written from the Device Class Definition for HID 1.11
 * (§6.2.2: report descriptors — short and long items, main, global and local items, report IDs,
 * collections) and the HID Usage Tables (page 0x01 Generic Desktop, 0x07 Keyboard/Keypad, 0x09
 * Button, 0x0C Consumer). Chip-neutral, DOM-free.
 *
 * `parseHidReports` reads a report descriptor into the input reports it declares: per report ID,
 * each Input field's bit offset, size, count, usages and logical range, and what the report is,
 * by its top-level application collection — keyboard (Generic Desktop 6, keypad 7), mouse (2,
 * pointer 1), consumer control (Consumer 1), system control (Generic Desktop 0x80), gamepad (5,
 * joystick 4), or other. BT145: of the output reports, a keyboard's lock LEDs (page 0x08: Num
 * Lock 1, Caps Lock 2, Scroll Lock 3) are found — where the host puts its lock state; feature
 * reports aren't read.
 *
 * `HidDecoder` turns each input report into what a computer shows (`UsbLog`): a keyboard's newly
 * pressed keys as text with a US layout (Shift and the host's Caps Lock — BT145: the lock keys
 * toggle the host's state, which all its keyboards share, and aren't typed; Enter a newline,
 * Backspace deletes, other keys and Ctrl/Alt/GUI chords as "[F1]", "[Ctrl+C]"); a mouse's
 * buttons and moves ("mouse: left down", "mouse: moved +20 -10", merged while it keeps moving);
 * media and system keys as they go down ("media: Volume Up"); a gamepad's buttons and axes.
 */

import type { UsbLog } from './usb-log.ts';

export type HidKind = 'keyboard' | 'mouse' | 'consumer' | 'system' | 'gamepad' | 'other';

export interface HidField {
  /** Bit offset in the report's data (after its report ID byte, when the device uses IDs). */
  readonly bit: number;
  readonly size: number;
  readonly count: number;
  /** A variable field: one full usage (page << 16 | id) per value, the last repeated. */
  readonly usages: readonly number[];
  /** An array field: values pick usages usageMin + (value − logicalMin). */
  readonly array: boolean;
  readonly usageMin: number;
  readonly usageMax: number;
  readonly relative: boolean;
  readonly constant: boolean;
  readonly logicalMin: number;
  readonly logicalMax: number;
}

export interface HidReport {
  /** The report ID (0: the device uses none). */
  readonly id: number;
  readonly kind: HidKind;
  readonly fields: readonly HidField[];
  /** Data bytes (without the ID byte). */
  readonly bytes: number;
}

/** BT145: where a keyboard's output report keeps its lock LEDs. */
export interface HidLeds {
  /** The output report's ID (0: the device uses none). */
  readonly id: number;
  /** Data bytes (without the ID byte). */
  readonly bytes: number;
  /** The bit of Num Lock, Caps Lock and Scroll Lock in the data (−1: not in the report). */
  readonly num: number;
  readonly caps: number;
  readonly scroll: number;
}

export interface HidLayout {
  /** Every input report starts with its ID byte. */
  readonly ids: boolean;
  readonly reports: readonly HidReport[];
  /** BT145: the first output report with lock LEDs, or null. */
  readonly leds: HidLeds | null;
}

/** BT145: the host's lock keys, one state its keyboards share; a keyboard's lock key toggles one. */
export interface HidLockState {
  readonly caps: boolean;
  toggle(lock: 'num' | 'caps' | 'scroll'): void;
}

/** Limits on untrusted descriptors. */
const MAX_DESCRIPTOR = 4096;
const MAX_FIELDS = 256;
const MAX_DEPTH = 16;
const MAX_REPORT_BITS = 8 * 512;

const APP_KINDS: ReadonlyMap<number, HidKind> = new Map([
  [0x10006, 'keyboard'],
  [0x10007, 'keyboard'],
  [0x10002, 'mouse'],
  [0x10001, 'mouse'],
  [0xc0001, 'consumer'],
  [0x10080, 'system'],
  [0x10005, 'gamepad'],
  [0x10004, 'gamepad'],
]);

interface Globals {
  page: number;
  logicalMin: number;
  logicalMax: number;
  size: number;
  count: number;
  id: number;
}

/** An item's data as unsigned, little-endian. */
function unsigned(d: Uint8Array, at: number, size: number): number {
  let v = 0;
  for (let i = size - 1; i >= 0; i--) v = v * 256 + d[at + i];
  return v;
}

/** An item's data as signed (two's complement in `size` bytes). */
function signed(d: Uint8Array, at: number, size: number): number {
  const v = unsigned(d, at, size);
  if (size === 0) return 0;
  const bits = size * 8;
  return v >= 2 ** (bits - 1) ? v - 2 ** bits : v;
}

/** A report descriptor's input reports, or why it can't be read. */
export function parseHidReports(d: Uint8Array): HidLayout | string {
  if (d.length > MAX_DESCRIPTOR) return `report descriptor of ${d.length} bytes (at most ${MAX_DESCRIPTOR})`;
  let g: Globals = { page: 0, logicalMin: 0, logicalMax: 0, size: 0, count: 0, id: 0 };
  const stack: Globals[] = [];
  let usages: number[] = [];
  let usageMin = -1;
  let usageMax = -1;
  /** Open collections: their full usage and whether each is an application collection. */
  const collections: { usage: number; app: boolean }[] = [];
  const reports = new Map<number, { kind: HidKind; fields: HidField[]; bits: number }>();
  const outputs = new Map<number, { bits: number; num: number; caps: number; scroll: number }>();
  let ids = false;
  let fields = 0;
  for (let o = 0; o < d.length; ) {
    const prefix = d[o];
    if (prefix === 0xfe) {
      // A long item: skip its data (HID 1.11 §6.2.2.3 defines none).
      if (o + 2 >= d.length) return 'truncated long item';
      o += 3 + d[o + 1];
      continue;
    }
    const size = [0, 1, 2, 4][prefix & 3];
    const type = (prefix >> 2) & 3;
    const tag = prefix >> 4;
    if (o + 1 + size > d.length) return `truncated item at byte ${o}`;
    const at = o + 1;
    o += 1 + size;
    const data = unsigned(d, at, size);
    if (type === 0) {
      // Main items.
      if (tag === 0x8) {
        if (g.id === 0 && ids) return 'an input item without a report ID after IDs were used';
        if (++fields > MAX_FIELDS) return `more than ${MAX_FIELDS} fields`;
        let report = reports.get(g.id);
        if (report === undefined) {
          const app = collections.find((c) => c.app);
          report = { kind: app === undefined ? 'other' : (APP_KINDS.get(app.usage) ?? 'other'), fields: [], bits: 0 };
          reports.set(g.id, report);
        }
        const bits = g.size * g.count;
        if (g.size > 32 || report.bits + bits > MAX_REPORT_BITS) return `report ${g.id} too large`;
        const array = (data & 2) === 0;
        const constant = (data & 1) !== 0;
        let logicalMax = g.logicalMax;
        if (g.logicalMin >= 0 && logicalMax < 0) logicalMax += 2 ** 32; // a positive range: the maximum is unsigned
        report.fields.push({
          bit: report.bits,
          size: g.size,
          count: g.count,
          usages: !array && usages.length === 0 && usageMin >= 0 ? range(usageMin, usageMax, g.count) : usages,
          array,
          usageMin: usageMin >= 0 ? usageMin : (usages[0] ?? 0),
          usageMax: usageMax >= 0 ? usageMax : (usages[usages.length - 1] ?? 0),
          relative: (data & 4) !== 0,
          constant,
          logicalMin: g.logicalMin,
          logicalMax: Math.min(logicalMax, 2 ** 32 - 1),
        });
        report.bits += bits;
      } else if (tag === 0x9) {
        // BT145: an Output item. Its LED usages (page 0x08) are where the host puts its locks.
        let out = outputs.get(g.id);
        if (out === undefined) outputs.set(g.id, (out = { bits: 0, num: -1, caps: -1, scroll: -1 }));
        const bits = g.size * g.count;
        if (g.size > 32 || out.bits + bits > MAX_REPORT_BITS) return `output report ${g.id} too large`;
        if ((data & 3) === 2 && g.size === 1) {
          const list = usages.length === 0 && usageMin >= 0 ? range(usageMin, usageMax, g.count) : usages;
          for (let i = 0; i < g.count && i < list.length; i++) {
            const bit = out.bits + i;
            if (list[i] === 0x80001 && out.num < 0) out.num = bit;
            else if (list[i] === 0x80002 && out.caps < 0) out.caps = bit;
            else if (list[i] === 0x80003 && out.scroll < 0) out.scroll = bit;
          }
        }
        out.bits += bits;
      } else if (tag === 0xa) {
        if (collections.length >= MAX_DEPTH) return `collections nested deeper than ${MAX_DEPTH}`;
        collections.push({ usage: usages[0] ?? (usageMin >= 0 ? usageMin : 0), app: data === 1 });
      } else if (tag === 0xc) {
        if (collections.length === 0) return 'an end of collection without a collection';
        collections.pop();
      }
      // Feature (0xB) reports aren't read.
      usages = [];
      usageMin = -1;
      usageMax = -1;
    } else if (type === 1) {
      // Global items.
      switch (tag) {
        case 0x0:
          g.page = data;
          break;
        case 0x1:
          g.logicalMin = signed(d, at, size);
          break;
        case 0x2:
          g.logicalMax = signed(d, at, size);
          break;
        case 0x7:
          g.size = data;
          break;
        case 0x8:
          if (data === 0 || data > 255) return `report ID ${data}`;
          g.id = data;
          ids = true;
          break;
        case 0x9:
          g.count = data;
          break;
        case 0xa:
          if (stack.length >= MAX_DEPTH) return 'too many pushes';
          stack.push({ ...g });
          break;
        case 0xb: {
          const popped = stack.pop();
          if (popped === undefined) return 'a pop without a push';
          g = popped;
          break;
        }
        default:
      }
    } else if (type === 2) {
      // Local items: usages (a 4-byte one carries its page), minimum and maximum.
      const full = size === 4 ? data : (g.page << 16) | data;
      if (tag === 0x0) {
        if (usages.length < 256) usages.push(full);
      } else if (tag === 0x1) usageMin = full;
      else if (tag === 0x2) usageMax = full;
    }
  }
  if (collections.length !== 0) return 'a collection left open';
  const out: HidReport[] = [];
  for (const [id, r] of reports) out.push({ id, kind: r.kind, fields: r.fields, bytes: Math.ceil(r.bits / 8) });
  let leds: HidLeds | null = null;
  for (const [id, o] of outputs) {
    if (o.num < 0 && o.caps < 0 && o.scroll < 0) continue;
    leds = { id, bytes: Math.ceil(o.bits / 8), num: o.num, caps: o.caps, scroll: o.scroll };
    break;
  }
  return { ids, reports: out, leds };
}

function range(min: number, max: number, count: number): number[] {
  const out: number[] = [];
  for (let u = min; u <= max && out.length < count; u++) out.push(u);
  return out;
}

/** `size` bits at `bit` of `data` (LSB first), sign-extended when `signed`. */
export function hidBits(data: Uint8Array, offset: number, bit: number, size: number, isSigned: boolean): number {
  let v = 0;
  for (let i = 0; i < size; i++) {
    const b = bit + i;
    const byte = data[offset + (b >> 3)] ?? 0;
    if (((byte >> (b & 7)) & 1) !== 0) v += 2 ** i;
  }
  return isSigned && size > 0 && v >= 2 ** (size - 1) ? v - 2 ** size : v;
}

// ── The US keyboard layout (HID Usage Tables, Keyboard/Keypad page 0x07) ────────────────────

const SHIFTED_DIGITS = '!@#$%^&*()';
/** Usages 0x2C–0x38: space and punctuation, unshifted and shifted. */
const PUNCT = ' -=[]\\#;\'`,./';
const PUNCT_SHIFT = ' _+{}|~:"~<>?';
const NAMED: ReadonlyMap<number, string> = new Map([
  [0x29, 'Esc'],
  [0x46, 'PrintScreen'],
  [0x47, 'ScrollLock'],
  [0x48, 'Pause'],
  [0x49, 'Insert'],
  [0x4a, 'Home'],
  [0x4b, 'PageUp'],
  [0x4c, 'Del'],
  [0x4d, 'End'],
  [0x4e, 'PageDown'],
  [0x4f, 'Right'],
  [0x50, 'Left'],
  [0x51, 'Down'],
  [0x52, 'Up'],
  [0x53, 'NumLock'],
  [0x65, 'Menu'],
]);
const KEYPAD = '/*-+\n1234567890.';

/** The text a key types with no Ctrl/Alt/GUI held, or null for a named key. */
function keyText(usage: number, shift: boolean, caps: boolean): string | null {
  if (usage >= 0x04 && usage <= 0x1d) {
    const letter = String.fromCharCode(0x61 + usage - 0x04);
    return shift !== caps ? letter.toUpperCase() : letter;
  }
  if (usage >= 0x1e && usage <= 0x27) return shift ? SHIFTED_DIGITS[usage - 0x1e] : String((usage - 0x1d) % 10);
  if (usage === 0x28) return '\n';
  if (usage === 0x2b) return '\t';
  if (usage >= 0x2c && usage <= 0x38) return (shift ? PUNCT_SHIFT : PUNCT)[usage - 0x2c];
  if (usage >= 0x54 && usage <= 0x63) return KEYPAD[usage - 0x54];
  if (usage === 0x64) return shift ? '|' : '\\';
  return null;
}

/** A key's name for "[…]": "F1", "Del", "Enter", or its unshifted character in capitals ("C", "1"). */
function keyName(usage: number): string {
  if (usage >= 0x3a && usage <= 0x45) return `F${usage - 0x39}`;
  if (usage >= 0x68 && usage <= 0x73) return `F${usage - 0x5b}`;
  const named = NAMED.get(usage);
  if (named !== undefined) return named;
  if (usage === 0x28 || usage === 0x58) return 'Enter';
  if (usage === 0x2a) return 'Backspace';
  if (usage === 0x2b) return 'Tab';
  if (usage === 0x2c) return 'Space';
  const text = keyText(usage, false, false);
  if (text !== null) return text.toUpperCase();
  return `key 0x${usage.toString(16).padStart(2, '0')}`;
}

// ── Consumer and system controls ────────────────────────────────────────────────────────

const CONSUMER_NAMES: ReadonlyMap<number, string> = new Map([
  [0x30, 'Power'],
  [0x40, 'Menu'],
  [0x6f, 'Brightness Up'],
  [0x70, 'Brightness Down'],
  [0xb0, 'Play'],
  [0xb1, 'Pause'],
  [0xb2, 'Record'],
  [0xb3, 'Fast Forward'],
  [0xb4, 'Rewind'],
  [0xb5, 'Next Track'],
  [0xb6, 'Previous Track'],
  [0xb7, 'Stop'],
  [0xb8, 'Eject'],
  [0xcd, 'Play/Pause'],
  [0xe2, 'Mute'],
  [0xe9, 'Volume Up'],
  [0xea, 'Volume Down'],
  [0x183, 'Media Player'],
  [0x18a, 'Mail'],
  [0x192, 'Calculator'],
  [0x194, 'File Browser'],
  [0x221, 'Search'],
  [0x223, 'Home'],
  [0x224, 'Back'],
  [0x225, 'Forward'],
  [0x226, 'Stop'],
  [0x227, 'Refresh'],
  [0x22a, 'Bookmarks'],
]);
const SYSTEM_NAMES: ReadonlyMap<number, string> = new Map([
  [0x81, 'Power Down'],
  [0x82, 'Sleep'],
  [0x83, 'Wake Up'],
]);
const BUTTON_NAMES = ['', 'left', 'right', 'middle', 'back', 'forward'];
const AXES: ReadonlyMap<number, string> = new Map([
  [0x10030, 'X'],
  [0x10031, 'Y'],
  [0x10032, 'Z'],
  [0x10033, 'Rx'],
  [0x10034, 'Ry'],
  [0x10035, 'Rz'],
  [0x10036, 'Slider'],
  [0x10037, 'Dial'],
]);
const HAT = ['up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left'];

const plus = (n: number): string => (n >= 0 ? `+${n}` : String(n));

/** Lock keys for a decoder on its own (tests): toggled, never sent anywhere. */
function ownLocks(): HidLockState {
  const state = { num: false, caps: false, scroll: false };
  return {
    get caps() {
      return state.caps;
    },
    toggle(lock) {
      state[lock] = !state[lock];
    },
  };
}

/** One report's per-ID state between reports. */
interface ReportState {
  readonly report: HidReport;
  /** Keyboard: keys down; others: active usages. */
  down: Set<number>;
  buttons: number;
  axes: string;
}

export class HidDecoder {
  /** The reports the host can show, and those it can't (kind 'other'). */
  readonly layout: HidLayout;
  private readonly log: UsbLog;
  private readonly states = new Map<number, ReportState>();
  /** BT145: the host's lock keys (its own, when the decoder runs alone). */
  private readonly locks: HidLockState;
  /** A mouse's moves since its last other event, for the merged "moved" line. */
  private dx = 0;
  private dy = 0;

  constructor(layout: HidLayout, log: UsbLog, locks?: HidLockState) {
    this.layout = layout;
    this.log = log;
    this.locks = locks ?? ownLocks();
    for (const report of layout.reports) this.states.set(report.id, { report, down: new Set(), buttons: 0, axes: '' });
  }

  /** The kinds of report this interface carries that the host reads ("keyboard", "mouse", …). */
  kinds(): HidKind[] {
    const kinds: HidKind[] = [];
    for (const r of this.layout.reports) if (!kinds.includes(r.kind)) kinds.push(r.kind);
    return kinds;
  }

  /** An input report of `length` bytes, as read from the interrupt IN endpoint. */
  report(data: Uint8Array, length: number): void {
    let offset = 0;
    let state: ReportState | undefined;
    if (this.layout.ids) {
      if (length < 1) return;
      state = this.states.get(data[0]);
      offset = 1;
    } else state = this.states.get(0);
    if (state === undefined || length - offset < state.report.bytes) return;
    switch (state.report.kind) {
      case 'keyboard':
        this.keyboard(state, data, offset);
        break;
      case 'mouse':
        this.mouse(state, data, offset);
        break;
      case 'consumer':
      case 'system':
        this.controls(state, data, offset);
        break;
      case 'gamepad':
        this.gamepad(state, data, offset);
        break;
      default:
    }
  }

  /** Usages a report's fields have active: array entries and variable bits that are set. */
  private active(report: HidReport, data: Uint8Array, offset: number, page: number, into: Set<number>): void {
    for (const f of report.fields) {
      if (f.constant) continue;
      for (let i = 0; i < f.count; i++) {
        const v = hidBits(data, offset, f.bit + i * f.size, f.size, f.logicalMin < 0);
        if (f.array) {
          if (v < f.logicalMin || v > f.logicalMax) continue;
          const usage = f.usageMin + (v - f.logicalMin);
          if (usage >>> 16 === page && (usage & 0xffff) > (page === 7 ? 3 : 0)) into.add(usage & 0xffff);
        } else if (f.size === 1 && v !== 0) {
          const usage = f.usages[Math.min(i, f.usages.length - 1)];
          if (usage !== undefined && usage >>> 16 === page) into.add(usage & 0xffff);
        }
      }
    }
  }

  private keyboard(state: ReportState, data: Uint8Array, offset: number): void {
    const down = new Set<number>();
    this.active(state.report, data, offset, 7, down);
    let mods = 0;
    for (const key of down) if (key >= 0xe0 && key <= 0xe7) mods |= 1 << (key - 0xe0);
    const shift = (mods & 0x22) !== 0;
    const chord = [(mods & 0x11) !== 0 ? 'Ctrl' : '', (mods & 0x44) !== 0 ? 'Alt' : '', (mods & 0x88) !== 0 ? 'GUI' : ''].filter((m) => m !== '');
    for (const key of down) {
      if (state.down.has(key) || (key >= 0xe0 && key <= 0xe7)) continue;
      if (key === 0x39 || key === 0x53 || key === 0x47) {
        this.locks.toggle(key === 0x39 ? 'caps' : key === 0x53 ? 'num' : 'scroll');
        continue;
      }
      if (chord.length > 0) {
        this.log.type(`[${[...chord, ...(shift ? ['Shift'] : [])].join('+')}+${keyName(key)}]`);
        continue;
      }
      if (key === 0x2a) {
        this.log.backspace();
        continue;
      }
      const text = keyText(key, shift, this.locks.caps);
      this.log.type(text ?? `[${shift ? 'Shift+' : ''}${keyName(key)}]`);
    }
    state.down = down;
  }

  private mouse(state: ReportState, data: Uint8Array, offset: number): void {
    let buttons = 0;
    let dx = 0;
    let dy = 0;
    let wheel = 0;
    let pan = 0;
    for (const f of state.report.fields) {
      if (f.constant || f.array) continue;
      for (let i = 0; i < f.count; i++) {
        const usage = f.usages[Math.min(i, f.usages.length - 1)];
        if (usage === undefined) continue;
        const v = hidBits(data, offset, f.bit + i * f.size, f.size, f.logicalMin < 0);
        if (usage >>> 16 === 9 && f.size === 1) {
          if (v !== 0) buttons |= 1 << ((usage & 0xffff) - 1);
        } else if (usage === 0x10030) dx = v;
        else if (usage === 0x10031) dy = v;
        else if (usage === 0x10038) wheel = v;
        else if (usage === 0xc0238) pan = v;
      }
    }
    for (let b = 1; b <= 8; b++) {
      const bit = 1 << (b - 1);
      if ((buttons & bit) !== (state.buttons & bit)) this.log.event(`mouse: ${BUTTON_NAMES[b] ?? `button ${b}`} ${(buttons & bit) !== 0 ? 'down' : 'up'}`);
    }
    state.buttons = buttons;
    if (dx !== 0 || dy !== 0) {
      if (this.log.lastKey === 'mouse-move') {
        this.dx += dx;
        this.dy += dy;
      } else {
        this.dx = dx;
        this.dy = dy;
      }
      this.log.event(`mouse: moved ${plus(this.dx)} ${plus(this.dy)}`, 'mouse-move');
    }
    if (wheel !== 0) this.log.event(`mouse: wheel ${plus(wheel)}`);
    if (pan !== 0) this.log.event(`mouse: pan ${plus(pan)}`);
  }

  private controls(state: ReportState, data: Uint8Array, offset: number): void {
    const consumer = state.report.kind === 'consumer';
    const down = new Set<number>();
    this.active(state.report, data, offset, consumer ? 0x0c : 0x01, down);
    for (const usage of down) {
      if (state.down.has(usage)) continue;
      const name = (consumer ? CONSUMER_NAMES : SYSTEM_NAMES).get(usage) ?? `usage 0x${usage.toString(16)}`;
      this.log.event(`${consumer ? 'media' : 'system'}: ${name}`);
    }
    state.down = down;
  }

  private gamepad(state: ReportState, data: Uint8Array, offset: number): void {
    let buttons = 0;
    const axes: string[] = [];
    for (const f of state.report.fields) {
      if (f.constant || f.array) continue;
      for (let i = 0; i < f.count; i++) {
        const usage = f.usages[Math.min(i, f.usages.length - 1)];
        if (usage === undefined) continue;
        const v = hidBits(data, offset, f.bit + i * f.size, f.size, f.logicalMin < 0);
        if (usage >>> 16 === 9 && f.size === 1) {
          if (v !== 0) buttons |= 2 ** ((usage & 0xffff) - 1);
        } else if (usage === 0x10039) {
          const hat = v - f.logicalMin;
          axes.push(`hat ${v < f.logicalMin || v > f.logicalMax || hat >= 8 ? 'centered' : HAT[hat]}`);
        } else {
          const axis = AXES.get(usage);
          if (axis !== undefined) axes.push(`${axis} ${v}`);
        }
      }
    }
    for (let b = 1; b <= 32; b++) {
      const bit = 2 ** (b - 1);
      if (Math.floor(buttons / bit) % 2 !== Math.floor(state.buttons / bit) % 2) this.log.event(`gamepad: button ${b} ${Math.floor(buttons / bit) % 2 === 1 ? 'down' : 'up'}`);
    }
    state.buttons = buttons;
    const text = axes.join(' ');
    if (text !== state.axes) this.log.event(`gamepad: ${text}`, 'gamepad-axes');
    state.axes = text;
  }
}
