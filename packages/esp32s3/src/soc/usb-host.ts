/**
 * The bench's USB host (BT134): the computer on the other end of the ESP32-S3's USB-OTG cable,
 * written from the USB 2.0 specification (chapter 9: the bus reset, control transfers, standard
 * requests and descriptors) and the CDC-ACM class (PSTN subclass: SET_LINE_CODING,
 * SET_CONTROL_LINE_STATE). Chip-neutral: it talks to a device controller through `UsbDevicePort`,
 * one transaction at a time — usb-otg.ts is the S3's.
 *
 * Attach: once the device pulls D+ up (`attached()`), the host waits 10 frames (debounce), resets
 * the bus for 10 frames (`busReset`, then `enumDone` at full speed) and after 2 more enumerates:
 * GET_DESCRIPTOR(device, 64), SET_ADDRESS(1), GET_DESCRIPTOR(device), GET_DESCRIPTOR(config) — 9
 * bytes, then all of it —, the language and product strings, SET_CONFIGURATION. Each CDC-ACM
 * function (a communication interface of subclass 2 and its data interface, by the union
 * descriptor or the next data interface) then gets SET_LINE_CODING (115200 8N1) and
 * SET_CONTROL_LINE_STATE (DTR and RTS) — what a serial monitor opening the port does — and from
 * then on its bulk IN endpoint is read (bytes to `onData`) and `send`'s bytes go out its bulk OUT
 * endpoint, as fast as the device ACKs. BT138: each HID interface's report descriptor is read
 * (GET_DESCRIPTOR(report), then SET_IDLE(0) as computers send it) and its interrupt IN endpoint
 * polled every bInterval frames, the reports decoded by usb-hid.ts; a MIDI streaming interface
 * (audio class, subclass 3) has its bulk IN endpoint read as CDC's is, the packets decoded by
 * usb-midi.ts. What they send goes to `log` (usb-log.ts: typed text and events). BT141: a mass
 * storage interface (class 8, SCSI, Bulk-Only) becomes `drive` (usb-msc.ts), mounted as a computer
 * mounts a flash drive. Interfaces of other classes (audio streaming, DFU, vendor…) enumerate and
 * are named once through `onNote`; nothing drives them.
 *
 * BT145: the host talks back. Its Num, Caps and Scroll Lock are one state for all its keyboards,
 * as a computer's: a keyboard's lock key toggles one (usb-hid.ts), and `setLocks` sets them. On
 * every change each keyboard whose report descriptor declares lock LEDs gets its output report —
 * on its interrupt OUT endpoint when it has one, else as SET_REPORT(Output) on endpoint 0 — and
 * after configuration it gets one when a lock is on, as Linux sends it. `sendMidi` turns whole
 * MIDI 1.0 messages into USB-MIDI packets (usb-midi.ts) for the first MIDI streaming interface
 * with a bulk OUT endpoint, sent as fast as the device takes them.
 *
 * Time: `frame()` is the 1 ms start-of-frame; `service()` runs whatever can make progress now and
 * is called on each frame and whenever the device changes something the host waits for (`kick` on
 * the controller's side). A transaction the device NAKs is retried on the next call; a control
 * transfer that makes no progress for 500 frames, or a STALL, fails (and is named in `onNote`
 * when enumeration needed it). No allocation per transaction.
 */

/** A transaction's outcome besides a length or ACK. */
import { HidDecoder, type HidLockState, parseHidReports } from './usb-hid.ts';
import { encodeMidi, MidiDecoder } from './usb-midi.ts';
import { MscDrive } from './usb-msc.ts';
import { UsbLog } from './usb-log.ts';

export const USB_NAK = -1;
export const USB_STALL = -2;
export const USB_ACK = 0;

/** What the host needs from a device controller: one transaction per call, at full speed. */
export interface UsbDevicePort {
  /** D+ pulled up on a powered PHY: a device on the cable. */
  attached(): boolean;
  /** The host starts a bus reset (USB reset signalling). */
  busReset(): void;
  /** The reset ends: the device is enumerated at full speed. */
  enumDone(): void;
  /** A start-of-frame with its 11-bit frame number. */
  sof(frame: number): void;
  /** A SETUP packet (8 bytes) to endpoint 0; always accepted. */
  setup(packet: Uint8Array): void;
  /** An IN token to endpoint `ep`: the packet's length (data into `into`), USB_NAK or USB_STALL. */
  in(ep: number, into: Uint8Array): number;
  /** An OUT packet of `length` bytes from `data` to endpoint `ep`: USB_ACK, USB_NAK or USB_STALL. */
  out(ep: number, data: Uint8Array, length: number): number;
}

/** A CDC-ACM function the host opened. */
export interface CdcPort {
  readonly comm: number;
  readonly bulkIn: number;
  readonly bulkOut: number;
  readonly outSize: number;
  readonly notify: number;
}

const STATE = { DETACHED: 0, DEBOUNCE: 1, RESET: 2, RECOVERY: 3, ENUMERATING: 4, RUNNING: 5, FAILED: 6 } as const;
type HostState = (typeof STATE)[keyof typeof STATE];
const STAGE = { SETUP: 0, DATA_IN: 1, DATA_OUT: 2, STATUS_IN: 3, STATUS_OUT: 4 } as const;
const DEBOUNCE_FRAMES = 10;
const RESET_FRAMES = 10;
const RECOVERY_FRAMES = 2;
const SET_ADDRESS_FRAMES = 2;
const STALLED_FRAMES = 500;
/** Packets per endpoint and direction per service call. */
const BURST = 4;

const CLASS_NAMES: ReadonlyMap<number, string> = new Map([
  [0x01, 'audio/MIDI'],
  [0x03, 'HID'],
  [0x05, 'physical'],
  [0x06, 'image'],
  [0x07, 'printer'],
  [0x08, 'mass storage'],
  [0x0b, 'smart card'],
  [0x0e, 'video'],
  [0x0f, 'personal healthcare'],
  [0xe0, 'wireless controller'],
  [0xef, 'miscellaneous'],
  [0xfe, 'application specific (DFU)'],
  [0xff, 'vendor specific'],
]);

/** BT138: a HID interface the host reads. */
interface HidInterface {
  readonly iface: number;
  /** The report descriptor's length (from the HID descriptor). */
  reportLength: number;
  inEp: number;
  /** Frames between polls (bInterval at full speed). */
  interval: number;
  nextPoll: number;
  decoder: HidDecoder | null;
  /** BT145: its interrupt OUT endpoint (−1: none — LED reports go as SET_REPORT) and packet size. */
  outEp: number;
  outSize: number;
  /** BT145: the lock state changed since this keyboard's last LED report. */
  ledsDirty: boolean;
}

/** BT138: a MIDI streaming interface the host reads. */
interface MidiInterface {
  readonly iface: number;
  inEp: number;
  /** BT145: its bulk OUT endpoint (−1: none) and packet size. */
  outEp: number;
  outSize: number;
  readonly decoder: MidiDecoder;
}

/** BT145: the host's lock keys as the bench reads them. */
export interface HostLocks {
  readonly num: boolean;
  readonly caps: boolean;
  readonly scroll: boolean;
}

/** What the host calls each kind of HID report it reads. */
const HID_KIND_NAMES = { keyboard: 'keyboard', mouse: 'mouse', consumer: 'media keys', system: 'system control', gamepad: 'gamepad', other: '' } as const;

interface ControlRequest {
  readonly setup: Uint8Array;
  /** Bytes to send (host → device data stage), or null. */
  readonly out: Uint8Array | null;
  readonly done: (data: Uint8Array | null) => void;
}

export class UsbHost {
  /** Bytes a CDC-ACM port's bulk IN endpoint delivered. */
  onData: ((bytes: Uint8Array, length: number) => void) | null = null;
  /** Things worth telling the user once: an interface nothing drives, a failed request. */
  onNote: ((message: string) => void) | null = null;
  /** The device is configured and its first CDC-ACM port open (DTR set). */
  onOpen: (() => void) | null = null;
  /** BT138: what the device's keyboards, mice, media keys and MIDI ports sent. */
  readonly log: UsbLog;
  private readonly port: UsbDevicePort;
  private state: HostState = STATE.DETACHED;
  private frameNumber = 0;
  private frames = 0;
  private waitUntil = 0;
  /** Requests still to send, in order. */
  private readonly queue: ControlRequest[] = [];
  private current: ControlRequest | null = null;
  private stage: number = STAGE.SETUP;
  private dataIn = new Uint8Array(0);
  private dataLength = 0;
  private outSent = 0;
  private progressAt = 0;
  private readonly packet = new Uint8Array(64);
  private readonly zero = new Uint8Array(0);
  private ep0Size = 8;
  private product = '';
  private configValue = 1;
  private readonly cdcs: CdcPort[] = [];
  /** Bytes for the first CDC-ACM port's bulk OUT endpoint (a ring). */
  private tx = new Uint8Array(4096);
  private txHead = 0;
  private txCount = 0;
  private readonly txPacket = new Uint8Array(64);
  private readonly hids: HidInterface[] = [];
  private readonly midis: MidiInterface[] = [];
  /** BT141: the first mass storage interface found (Bulk-Only, SCSI), before it starts. */
  private mscFound: { iface: number; bulkIn: number; bulkOut: number; outSize: number } | null = null;
  /** BT141: the device's USB drive, once the host runs it. */
  drive: MscDrive | null = null;
  /** What the device offers, as the host drives it ("serial (CDC-ACM)", "keyboard", "MIDI", …). */
  private functionNames: string[] = [];
  /** BT145: the host's lock keys, which its keyboards share (and toggle). */
  private readonly lockState: HidLockState & { num: boolean; caps: boolean; scroll: boolean };
  /** BT145: a keyboard's LED output report as it is sent. */
  private readonly ledPacket = new Uint8Array(64);
  /** BT145: USB-MIDI packets for the device (a ring of bytes, 4 a packet). */
  private midiTx = new Uint8Array(1024);
  private midiHead = 0;
  private midiCount = 0;
  private readonly midiPacket = new Uint8Array(64);
  /** BT145: the MIDI streaming interface the host's MIDI goes to (the first with a bulk OUT). */
  private midiOut: MidiInterface | null = null;

  /** `now`: the clock the log's events carry (the MCU's seconds). */
  constructor(port: UsbDevicePort, now: () => number = () => 0) {
    this.port = port;
    this.log = new UsbLog(now);
    const host = this;
    this.lockState = {
      num: false,
      caps: false,
      scroll: false,
      toggle(lock) {
        this[lock] = !this[lock];
        host.locksChanged();
      },
    };
  }

  /** BT145: the host's Num, Caps and Scroll Lock. */
  get locks(): HostLocks {
    return { num: this.lockState.num, caps: this.lockState.caps, scroll: this.lockState.scroll };
  }

  /** BT145: sets the host's lock keys; every keyboard with lock LEDs then gets its report. */
  setLocks(locks: HostLocks): void {
    const s = this.lockState;
    if (s.num === locks.num && s.caps === locks.caps && s.scroll === locks.scroll) return;
    s.num = locks.num;
    s.caps = locks.caps;
    s.scroll = locks.scroll;
    this.locksChanged();
  }

  /** BT145: a keyboard (of the device's) whose report takes lock LEDs. */
  get keyboardLeds(): boolean {
    return this.state === STATE.RUNNING && this.hids.some((h) => (h.decoder?.layout.leds ?? null) !== null);
  }

  /** BT145: the device has a MIDI port the host can send to. */
  get midiIn(): boolean {
    return this.state === STATE.RUNNING && this.midiOut !== null;
  }

  /**
   * BT145: whole MIDI 1.0 messages for the device's MIDI port, sent as USB-MIDI packets once it
   * takes them; why not when it can't (no device running, no MIDI port, a malformed message).
   */
  sendMidi(bytes: Uint8Array): string | null {
    if (this.state !== STATE.RUNNING) return 'no USB device is running on the port';
    if (this.midiOut === null) return `${this.deviceName()} has no MIDI port to send to`;
    const packets = encodeMidi(bytes);
    if (typeof packets === 'string') return packets;
    for (let i = 0; i < packets.length; i++) {
      if (this.midiCount === this.midiTx.length) {
        const grown = new Uint8Array(this.midiTx.length * 2);
        for (let j = 0; j < this.midiCount; j++) grown[j] = this.midiTx[(this.midiHead + j) % this.midiTx.length];
        this.midiTx = grown;
        this.midiHead = 0;
      }
      this.midiTx[(this.midiHead + this.midiCount) % this.midiTx.length] = packets[i];
      this.midiCount++;
    }
    return null;
  }

  /** BT145: the lock state changed: each keyboard with lock LEDs gets a report. */
  private locksChanged(): void {
    for (const hid of this.hids) if ((hid.decoder?.layout.leds ?? null) !== null) hid.ledsDirty = true;
  }

  /** BT138: where the host is: nothing attached, enumerating, running, or failed. */
  get phase(): 'waiting' | 'enumerating' | 'running' | 'failed' {
    if (this.state === STATE.RUNNING) return 'running';
    if (this.state === STATE.FAILED) return 'failed';
    return this.state === STATE.DETACHED ? 'waiting' : 'enumerating';
  }

  /** BT138: the device's functions the host uses (empty until running). */
  get functions(): readonly string[] {
    return this.state === STATE.RUNNING ? this.functionNames : [];
  }

  /** Enumerated and running, with the CDC-ACM ports it opened. */
  get isRunning(): boolean {
    return this.state === STATE.RUNNING;
  }

  /** The device's product string (once enumerated). */
  get productName(): string {
    return this.product;
  }

  /** The CDC-ACM ports opened (empty until running). */
  get ports(): readonly CdcPort[] {
    return this.state === STATE.RUNNING ? this.cdcs : [];
  }

  /** Bytes waiting for the device's CDC port. */
  get pendingTx(): number {
    return this.txCount;
  }

  /** Bytes for the device's first CDC-ACM port (sent once it is open). */
  send(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      if (this.txCount === this.tx.length) {
        const grown = new Uint8Array(this.tx.length * 2);
        for (let j = 0; j < this.txCount; j++) grown[j] = this.tx[(this.txHead + j) % this.tx.length];
        this.tx = grown;
        this.txHead = 0;
      }
      this.tx[(this.txHead + this.txCount) % this.tx.length] = bytes[i];
      this.txCount++;
    }
  }

  /** A 1 ms frame: a start-of-frame while attached, then whatever can progress. */
  frame(): void {
    this.frames++;
    if (this.state >= STATE.RECOVERY && this.state !== STATE.FAILED) {
      this.frameNumber = (this.frameNumber + 1) & 0x7ff;
      this.port.sof(this.frameNumber);
    }
    this.service();
  }

  /** Runs what can make progress now (a device change, or a frame). */
  service(): void {
    if (!this.port.attached()) {
      if (this.state !== STATE.DETACHED) this.detach();
      return;
    }
    switch (this.state) {
      case STATE.DETACHED:
        this.state = STATE.DEBOUNCE;
        this.waitUntil = this.frames + DEBOUNCE_FRAMES;
        return;
      case STATE.DEBOUNCE:
        if (this.frames < this.waitUntil) return;
        this.port.busReset();
        this.state = STATE.RESET;
        this.waitUntil = this.frames + RESET_FRAMES;
        return;
      case STATE.RESET:
        if (this.frames < this.waitUntil) return;
        this.port.enumDone();
        this.state = STATE.RECOVERY;
        this.waitUntil = this.frames + RECOVERY_FRAMES;
        return;
      case STATE.RECOVERY:
        if (this.frames < this.waitUntil) return;
        this.state = STATE.ENUMERATING;
        this.enumerate();
        this.control();
        return;
      case STATE.ENUMERATING:
        if (this.frames >= this.waitUntil) this.control();
        return;
      case STATE.RUNNING:
        this.control();
        this.cdcIo();
        this.hidIo();
        this.midiIo();
        this.drive?.service(this.port);
        return;
      default:
    }
  }

  private detach(): void {
    this.state = STATE.DETACHED;
    this.queue.length = 0;
    this.current = null;
    this.cdcs.length = 0;
    this.hids.length = 0;
    this.midis.length = 0;
    this.mscFound = null;
    this.drive = null;
    this.functionNames = [];
    this.product = '';
    this.midiHead = 0;
    this.midiCount = 0;
    this.midiOut = null;
  }

  // ── Control transfers ─────────────────────────────────────────────────────────────────

  private request(bmRequestType: number, bRequest: number, wValue: number, wIndex: number, wLength: number, out: Uint8Array | null, done: (data: Uint8Array | null) => void): void {
    const setup = new Uint8Array([bmRequestType, bRequest, wValue & 0xff, wValue >>> 8, wIndex & 0xff, wIndex >>> 8, wLength & 0xff, wLength >>> 8]);
    this.queue.push({ setup, out, done });
  }

  /** One step of the current control transfer (or the next one's SETUP). */
  private control(): void {
    if (this.current === null) {
      const next = this.queue.shift();
      if (next === undefined) return;
      this.current = next;
      this.stage = STAGE.SETUP;
    }
    const request = this.current;
    const wLength = request.setup[6] | (request.setup[7] << 8);
    const toHost = (request.setup[0] & 0x80) !== 0;
    if (this.stage === STAGE.SETUP) {
      this.port.setup(request.setup);
      this.progressAt = this.frames;
      this.dataLength = 0;
      this.outSent = 0;
      if (toHost && wLength > 0) {
        if (this.dataIn.length < wLength) this.dataIn = new Uint8Array(Math.max(wLength, 256));
        this.stage = STAGE.DATA_IN;
      } else if (!toHost && wLength > 0) this.stage = STAGE.DATA_OUT;
      else this.stage = STAGE.STATUS_IN;
      return;
    }
    for (let i = 0; i < BURST; i++) {
      const before = this.stage;
      if (!this.controlStep(request, wLength)) break;
      if (this.current !== request || this.stage === before) break;
    }
    if (this.current === request && this.frames - this.progressAt > STALLED_FRAMES) this.finish(request, null, 'timed out');
  }

  /** One transaction of `request`'s data or status stage; false when the device NAKed. */
  private controlStep(request: ControlRequest, wLength: number): boolean {
    switch (this.stage) {
      case STAGE.DATA_IN: {
        const n = this.port.in(0, this.packet);
        if (n === USB_NAK) return false;
        if (n === USB_STALL) {
          this.finish(request, null, 'stalled');
          return true;
        }
        const take = Math.min(n, wLength - this.dataLength);
        this.dataIn.set(this.packet.subarray(0, take), this.dataLength);
        this.dataLength += take;
        this.progressAt = this.frames;
        if (n < this.ep0Size || this.dataLength >= wLength) this.stage = STAGE.STATUS_OUT;
        return true;
      }
      case STAGE.DATA_OUT: {
        const data = request.out ?? this.zero;
        const n = Math.min(this.ep0Size, data.length - this.outSent);
        const result = this.port.out(0, data.subarray(this.outSent), n);
        if (result === USB_NAK) return false;
        if (result === USB_STALL) {
          this.finish(request, null, 'stalled');
          return true;
        }
        this.outSent += n;
        this.progressAt = this.frames;
        if (this.outSent >= data.length) this.stage = STAGE.STATUS_IN;
        return true;
      }
      case STAGE.STATUS_OUT: {
        const result = this.port.out(0, this.zero, 0);
        if (result === USB_NAK) return false;
        this.finish(request, result === USB_STALL ? null : this.dataIn.slice(0, this.dataLength), 'stalled');
        return true;
      }
      case STAGE.STATUS_IN: {
        const n = this.port.in(0, this.packet);
        if (n === USB_NAK) return false;
        this.finish(request, n === USB_STALL ? null : this.zero, 'stalled');
        return true;
      }
      default:
        return false;
    }
  }

  private finish(request: ControlRequest, data: Uint8Array | null, why: string): void {
    this.current = null;
    if (data === null && this.state === STATE.ENUMERATING) this.failing = `${describe(request.setup)} ${why}`;
    request.done(data);
  }

  /** What failed while enumerating (named when enumeration gives up). */
  private failing = '';

  // ── Enumeration ───────────────────────────────────────────────────────────────────────

  private enumerate(): void {
    this.ep0Size = 64;
    this.cdcs.length = 0;
    this.hids.length = 0;
    this.midis.length = 0;
    this.mscFound = null;
    this.drive = null;
    this.request(0x80, 6, 0x0100, 0, 64, null, (device) => {
      if (device === null || device.length < 8) return this.fail();
      this.ep0Size = device[7] === 8 || device[7] === 16 || device[7] === 32 || device[7] === 64 ? device[7] : 8;
      this.request(0x00, 5, 1, 0, 0, null, (ok) => {
        if (ok === null) return this.fail();
        this.waitUntil = this.frames + SET_ADDRESS_FRAMES;
        this.getRest();
      });
    });
  }

  private getRest(): void {
    this.request(0x80, 6, 0x0100, 0, 18, null, (device) => {
      if (device === null || device.length < 18) return this.fail();
      const iProduct = device[15];
      this.request(0x80, 6, 0x0200, 0, 9, null, (head) => {
        if (head === null || head.length < 9) return this.fail();
        const total = head[2] | (head[3] << 8);
        this.request(0x80, 6, 0x0200, 0, total, null, (config) => {
          if (config === null || config.length < 9) return this.fail();
          this.configValue = config[5];
          const notes = this.parseConfig(config);
          this.request(0x80, 6, 0x0300, 0, 255, null, (langs) => {
            const lang = langs !== null && langs.length >= 4 ? langs[2] | (langs[3] << 8) : 0x0409;
            const configure = (): void => {
              this.request(0x00, 9, this.configValue, 0, 0, null, (ok) => {
                if (ok === null) return this.fail();
                for (const note of notes) this.onNote?.(`${this.deviceName()}: ${note}`);
                this.openCdcs();
              });
            };
            if (iProduct === 0) configure();
            else
              this.request(0x80, 6, 0x0300 | iProduct, lang, 255, null, (name) => {
                if (name !== null) this.product = utf16(name);
                configure();
              });
          });
        });
      });
    });
  }

  /** The CDC-ACM functions in a configuration descriptor; notes on interfaces nothing drives. */
  private parseConfig(config: Uint8Array): string[] {
    const notes: string[] = [];
    let iface = -1;
    let ifaceClass = -1;
    let ifaceSubclass = -1;
    let ifaceProtocol = -1;
    let pendingComm: { comm: number; notify: number; data: number } | null = null;
    const datas = new Map<number, { bulkIn: number; bulkOut: number; outSize: number }>();
    const comms: { comm: number; notify: number; data: number }[] = [];
    const named = new Set<number>();
    for (let o = 0; o + 2 <= config.length; ) {
      const length = config[o];
      const type = config[o + 1];
      if (length < 2 || o + length > config.length) break;
      if (type === 4 && length >= 9) {
        iface = config[o + 2];
        ifaceClass = config[o + 5];
        ifaceSubclass = config[o + 6];
        ifaceProtocol = config[o + 7];
        if (ifaceClass === 0x02 && ifaceSubclass === 0x02) {
          pendingComm = { comm: iface, notify: -1, data: -1 };
          comms.push(pendingComm);
        } else if (ifaceClass === 0x0a) {
          if (!datas.has(iface)) datas.set(iface, { bulkIn: -1, bulkOut: -1, outSize: 64 });
        } else if (ifaceClass === 0x03) {
          if (!this.hids.some((h) => h.iface === iface)) this.hids.push({ iface, reportLength: 0, inEp: -1, interval: 1, nextPoll: 0, decoder: null, outEp: -1, outSize: 64, ledsDirty: false });
        } else if (ifaceClass === 0x01 && ifaceSubclass === 0x03) {
          if (!this.midis.some((m) => m.iface === iface)) this.midis.push({ iface, inEp: -1, outEp: -1, outSize: 64, decoder: new MidiDecoder(this.log) });
        } else if (ifaceClass === 0x01 && ifaceSubclass === 0x01) {
          // Audio control: the MIDI streaming interface's companion; nothing to read.
        } else if (ifaceClass === 0x08 && ifaceSubclass === 0x06 && ifaceProtocol === 0x50 && this.mscFound === null) {
          this.mscFound = { iface, bulkIn: -1, bulkOut: -1, outSize: 64 };
        } else if (!named.has(iface) && ifaceClass !== 0x02) {
          named.add(iface);
          const name = CLASS_NAMES.get(ifaceClass) ?? `class 0x${ifaceClass.toString(16).padStart(2, '0')}`;
          notes.push(`its ${name} interface (${iface}) enumerates, but the bench's USB host doesn't drive it`);
        }
      } else if (type === 0x24 && length >= 5 && config[o + 2] === 0x06 && pendingComm !== null) {
        pendingComm.data = config[o + 4]; // union: the subordinate (data) interface
      } else if (type === 0x21 && length >= 9 && ifaceClass === 0x03 && config[o + 6] === 0x22) {
        const hid = this.hids.find((h) => h.iface === iface);
        if (hid !== undefined) hid.reportLength = config[o + 7] | (config[o + 8] << 8);
      } else if (type === 5 && length >= 7) {
        const address = config[o + 2];
        const kind = config[o + 3] & 3;
        const size = (config[o + 4] | (config[o + 5] << 8)) & 0x7ff;
        if (ifaceClass === 0x0a) {
          const data = datas.get(iface);
          if (data !== undefined && kind === 2) {
            if ((address & 0x80) !== 0) data.bulkIn = address & 0x0f;
            else {
              data.bulkOut = address & 0x0f;
              data.outSize = Math.min(64, size || 64);
            }
          }
        } else if (ifaceClass === 0x02 && pendingComm !== null && kind === 3 && (address & 0x80) !== 0) pendingComm.notify = address & 0x0f;
        else if (ifaceClass === 0x03 && kind === 3) {
          const hid = this.hids.find((h) => h.iface === iface);
          if (hid !== undefined && (address & 0x80) !== 0 && hid.inEp < 0) {
            hid.inEp = address & 0x0f;
            hid.interval = Math.max(1, config[o + 6]);
          } else if (hid !== undefined && (address & 0x80) === 0 && hid.outEp < 0) {
            hid.outEp = address & 0x0f; // BT145: where its LED reports go
            hid.outSize = Math.min(64, size || 64);
          }
        } else if (ifaceClass === 0x01 && ifaceSubclass === 0x03 && kind === 2) {
          const midi = this.midis.find((m) => m.iface === iface);
          if (midi !== undefined && (address & 0x80) !== 0 && midi.inEp < 0) midi.inEp = address & 0x0f;
          else if (midi !== undefined && (address & 0x80) === 0 && midi.outEp < 0) {
            midi.outEp = address & 0x0f; // BT145: where the host's MIDI goes
            midi.outSize = Math.min(64, size || 64);
          }
        } else if (ifaceClass === 0x08 && kind === 2 && this.mscFound !== null && this.mscFound.iface === iface) {
          if ((address & 0x80) !== 0) this.mscFound.bulkIn = address & 0x0f;
          else {
            this.mscFound.bulkOut = address & 0x0f;
            this.mscFound.outSize = Math.min(64, size || 64);
          }
        }
      }
      o += length;
    }
    for (const comm of comms) {
      let dataIface = comm.data;
      if (dataIface < 0 || !datas.has(dataIface)) for (const key of datas.keys()) if (key > comm.comm) {
        dataIface = key;
        break;
      }
      const data = datas.get(dataIface);
      if (data === undefined || data.bulkIn < 0 || data.bulkOut < 0) continue;
      this.cdcs.push({ comm: comm.comm, bulkIn: data.bulkIn, bulkOut: data.bulkOut, outSize: data.outSize, notify: comm.notify });
    }
    for (let i = this.hids.length - 1; i >= 0; i--) {
      const hid = this.hids[i];
      if (hid.inEp >= 0 && hid.reportLength > 0) continue;
      notes.push(`its HID interface (${hid.iface}) has no interrupt IN endpoint or report descriptor: the bench's USB host can't read it`);
      this.hids.splice(i, 1);
    }
    for (let i = this.midis.length - 1; i >= 0; i--) {
      if (this.midis[i].inEp >= 0 || this.midis[i].outEp >= 0) continue;
      notes.push(`its MIDI interface (${this.midis[i].iface}) has no bulk endpoints: the bench's USB host can't use it`);
      this.midis.splice(i, 1);
    }
    this.midiOut = this.midis.find((m) => m.outEp >= 0) ?? null;
    if (this.mscFound !== null && (this.mscFound.bulkIn < 0 || this.mscFound.bulkOut < 0)) {
      notes.push(`its mass storage interface (${this.mscFound.iface}) lacks a bulk endpoint: the bench's USB host can't read it`);
      this.mscFound = null;
    }
    this.functionNames = this.cdcs.map(() => 'serial (CDC-ACM)');
    if (this.midis.length > 0) this.functionNames.push('MIDI');
    if (this.mscFound !== null) this.functionNames.push('drive (mass storage)');
    return notes;
  }

  private openCdcs(): void {
    if (this.cdcs.length === 0) {
      this.openHids();
      return;
    }
    let left = this.cdcs.length;
    for (const cdc of this.cdcs) {
      // 115200 baud, 1 stop bit, no parity, 8 data bits.
      const coding = new Uint8Array([0x00, 0xc2, 0x01, 0x00, 0, 0, 8]);
      this.request(0x21, 0x20, 0, cdc.comm, 7, coding, () => {
        this.request(0x21, 0x22, 0x0003, cdc.comm, 0, null, () => {
          left--;
          if (left === 0) this.openHids();
        });
      });
    }
  }

  /**
   * BT138: each HID interface's report descriptor (GET_DESCRIPTOR(report) to the interface), then
   * SET_IDLE(0) — what a computer sends (a stall is fine) —, then running.
   */
  private openHids(): void {
    let left = this.hids.length;
    if (left === 0) {
      this.openDrive();
      return;
    }
    for (const hid of this.hids) {
      this.request(0x81, 6, 0x2200, hid.iface, hid.reportLength, null, (descriptor) => {
        const layout = descriptor === null ? 'the device stalled GET_DESCRIPTOR(report)' : parseHidReports(descriptor);
        if (typeof layout === 'string') this.onNote?.(`${this.deviceName()}: its HID interface (${hid.iface}) can't be read: ${layout}`);
        else {
          hid.decoder = new HidDecoder(layout, this.log, this.lockState);
          // BT145: a computer tells a new keyboard its locks when one is on (Linux does).
          const s = this.lockState;
          if (layout.leds !== null && (s.num || s.caps || s.scroll)) hid.ledsDirty = true;
          const kinds = hid.decoder.kinds();
          for (const kind of kinds) {
            const name = HID_KIND_NAMES[kind];
            if (name !== '' && !this.functionNames.includes(name)) this.functionNames.push(name);
          }
          if (kinds.includes('other')) this.onNote?.(`${this.deviceName()}: its HID interface (${hid.iface}) also sends reports that aren't a keyboard, mouse, media keys or gamepad (vendor-defined): the bench's USB host doesn't read those`);
        }
        this.request(0x21, 0x0a, 0, hid.iface, 0, null, () => {
          left--;
          if (left === 0) this.openDrive();
        });
      });
    }
  }

  /** BT141: the mass storage interface becomes the drive (it probes and mounts while running). */
  private openDrive(): void {
    const found = this.mscFound;
    if (found !== null) {
      this.drive = new MscDrive(found.iface, found.bulkIn, found.bulkOut, found.outSize, {
        request: (type, request, value, index, length, out, done) => this.request(type, request, value, index, length, out, done),
        frames: () => this.frames,
        note: (message) => this.onNote?.(`${this.deviceName()}: ${message}`),
      });
      this.drive.start();
    }
    this.started();
  }

  private started(): void {
    this.state = STATE.RUNNING;
    if (this.cdcs.length > 0) this.onOpen?.();
  }

  private fail(): void {
    this.state = STATE.FAILED;
    this.queue.length = 0;
    this.current = null;
    this.onNote?.(`the USB device didn't enumerate: ${this.failing || 'a malformed descriptor'}`);
  }

  private deviceName(): string {
    return this.product === '' ? 'the USB device' : `USB device "${this.product}"`;
  }

  // ── HID and MIDI data (BT138) ─────────────────────────────────────────────────────────

  /** Each HID interface's interrupt IN endpoint, once per its interval in frames (BT145: its LEDs first). */
  private hidIo(): void {
    for (let i = 0; i < this.hids.length; i++) {
      const hid = this.hids[i];
      if (hid.ledsDirty) this.sendLeds(hid);
      if (hid.decoder === null || this.frames < hid.nextPoll) continue;
      hid.nextPoll = this.frames + hid.interval;
      const n = this.port.in(hid.inEp, this.packet);
      if (n > 0) hid.decoder.report(this.packet, n);
    }
  }

  /**
   * BT145: a keyboard's LED output report — the report ID first when the device uses IDs — on its
   * interrupt OUT endpoint (again next time when NAKed), else as SET_REPORT(Output).
   */
  private sendLeds(hid: HidInterface): void {
    const leds = hid.decoder?.layout.leds ?? null;
    if (leds === null) {
      hid.ledsDirty = false;
      return;
    }
    const ids = leds.id !== 0;
    const n = Math.min(this.ledPacket.length, leds.bytes + (ids ? 1 : 0));
    const p = this.ledPacket;
    p.fill(0, 0, n);
    if (ids) p[0] = leds.id;
    const base = ids ? 8 : 0;
    const s = this.lockState;
    if (s.num && leds.num >= 0) p[(base + leds.num) >> 3] |= 1 << ((base + leds.num) & 7);
    if (s.caps && leds.caps >= 0) p[(base + leds.caps) >> 3] |= 1 << ((base + leds.caps) & 7);
    if (s.scroll && leds.scroll >= 0) p[(base + leds.scroll) >> 3] |= 1 << ((base + leds.scroll) & 7);
    if (hid.outEp >= 0 && n <= hid.outSize) {
      const result = this.port.out(hid.outEp, p, n);
      if (result === USB_NAK) return;
      hid.ledsDirty = false;
      if (result === USB_STALL) this.onNote?.(`${this.deviceName()}: its keyboard stalled the lock LEDs' report`);
      return;
    }
    hid.ledsDirty = false;
    this.request(0x21, 0x09, 0x0200 | leds.id, hid.iface, n, p.slice(0, n), () => {});
  }

  /** Each MIDI streaming interface's bulk IN endpoint: 4-byte event packets (BT145: and the host's out). */
  private midiIo(): void {
    for (let m = 0; m < this.midis.length; m++) {
      const midi = this.midis[m];
      if (midi === this.midiOut && this.midiCount > 0) {
        for (let i = 0; i < BURST && this.midiCount > 0; i++) {
          const n = Math.min(this.midiCount, midi.outSize - (midi.outSize % 4));
          for (let j = 0; j < n; j++) this.midiPacket[j] = this.midiTx[(this.midiHead + j) % this.midiTx.length];
          if (this.port.out(midi.outEp, this.midiPacket, n) !== USB_ACK) break;
          this.midiHead = (this.midiHead + n) % this.midiTx.length;
          this.midiCount -= n;
        }
      }
      if (midi.inEp < 0) continue;
      for (let i = 0; i < BURST; i++) {
        const n = this.port.in(midi.inEp, this.packet);
        if (n < 0) break;
        for (let at = 0; at + 4 <= n; at += 4) midi.decoder.packet(this.packet, at);
      }
    }
  }

  // ── CDC-ACM data ──────────────────────────────────────────────────────────────────────

  private cdcIo(): void {
    for (let c = 0; c < this.cdcs.length; c++) {
      const cdc = this.cdcs[c];
      for (let i = 0; i < BURST; i++) {
        const n = this.port.in(cdc.bulkIn, this.packet);
        if (n < 0) break;
        if (n > 0) this.onData?.(this.packet, n);
      }
      if (cdc.notify >= 0) this.port.in(cdc.notify, this.packet);
      if (c !== 0) continue;
      for (let i = 0; i < BURST && this.txCount > 0; i++) {
        const n = Math.min(cdc.outSize, this.txCount);
        for (let j = 0; j < n; j++) this.txPacket[j] = this.tx[(this.txHead + j) % this.tx.length];
        if (this.port.out(cdc.bulkOut, this.txPacket, n) !== USB_ACK) break;
        this.txHead = (this.txHead + n) % this.tx.length;
        this.txCount -= n;
      }
    }
  }
}

/** A SETUP packet as words ("GET_DESCRIPTOR(0x0200)"), for notes. */
function describe(setup: Uint8Array): string {
  const names = ['GET_STATUS', 'CLEAR_FEATURE', '', 'SET_FEATURE', '', 'SET_ADDRESS', 'GET_DESCRIPTOR', 'SET_DESCRIPTOR', 'GET_CONFIGURATION', 'SET_CONFIGURATION'];
  const value = setup[2] | (setup[3] << 8);
  const name = (setup[0] & 0x60) === 0 ? names[setup[1]] || `request ${setup[1]}` : `class request 0x${setup[1].toString(16)}`;
  return `${name}(0x${value.toString(16).padStart(4, '0')})`;
}

/** A string descriptor's UTF-16LE text. */
function utf16(descriptor: Uint8Array): string {
  let text = '';
  const end = Math.min(descriptor.length, descriptor[0] || descriptor.length);
  for (let i = 2; i + 1 < end; i += 2) text += String.fromCharCode(descriptor[i] | (descriptor[i + 1] << 8));
  return text;
}
