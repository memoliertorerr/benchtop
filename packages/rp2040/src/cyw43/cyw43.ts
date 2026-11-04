/**
 * The Raspberry Pi Pico W's CYW43439 at its driver's low-level API (BT110, BT111). A Pico W
 * firmware carries the whole cyw43-driver (in arduino-pico's libpico.a) and the chip's closed
 * firmware blob, which `cyw43_ll_bus_init` would upload over a PIO-driven gSPI bus (GP23
 * WL_REG_ON, GP24 data / host-wake, GP25 CS, GP29 clock). Neither the bus nor the chip is
 * modeled: the functions of cyw43_ll.c — the layer that talks to the bus — are answered by name
 * (rp2040's hle.ts), and everything above them is the firmware's own code: cyw43_ctrl.c (the join
 * state machine, scan bookkeeping, link up/down), the SDK's cyw43_arch and async context, lwIP,
 * arduino-pico's WiFi.
 *
 * Answered here: the bring-up (`cyw43_ll_init` keeps the ll state's address and the callback
 * data, `cyw43_ll_bus_init` "uploads" nothing and succeeds), the MAC from OTP
 * (`cyw43_ll_wifi_get_mac`: the board's), the chip's GPIOs (`cyw43_ll_gpio_set/get`: WL_GPIO0 is
 * the board's LED), power management and radio on (accepted), ioctls, and the poll path: work
 * for the firmware (async events, received frames) waits in a queue, the chip raises host-wake
 * (GP24) — the driver's level-high GPIO interrupt schedules its poll on the async context — and
 * `cyw43_ll_has_work` / `cyw43_ll_process_packets` hand each item to
 * `cyw43_cb_process_async_event` or `cyw43_cb_process_ethernet` (arduino-pico wraps the latter:
 * `__wrap_cyw43_cb_process_ethernet`), in the ll state's own memory (2 KB the replaced layer no
 * longer uses), then lower host-wake.
 *
 * BT111, the station, on the bench's radio (`setRadio`): a scan (`cyw43_ll_wifi_scan`) dwells
 * SCAN_DWELL_MS on each of 13 channels and reports each access point it hears as an ESCAN_RESULT
 * event (status 8, partial) when it reaches that channel — hidden ones only to a scan for their
 * SSID — then the scan's end (status 0). A join (`cyw43_ll_wifi_join`) searches the same way for
 * the SSID (and BSSID, when given) and answers in the chip's events, which cyw43_ctrl.c's state
 * machine reads: found, with matching security and key, AUTH (0), LINK (up) and SET_SSID (0),
 * then — WPA/WPA2/WPA3 — PSK_SUP keyed (6) after the 4-way handshake; the station joins the AP's
 * LAN at LINK. Not found, or found with other security (a key for an open network, none for a
 * protected one: the chip prunes it), SET_SSID (3): no network. A wrong key: AUTH (0), then after
 * KEY_TIMEOUT_MS PSK_SUP failed — bad auth. A new join cancels one still under way. Leaving
 * (the SET_DISASSOC ioctl) and an access point switched off (after BEACON_LOSS_MS without
 * beacons) report DISASSOC: link down. Frames: `cyw43_ll_send_ethernet` onto the LAN (a pbuf
 * chain when the caller says so), and frames for the station queue (RX_QUEUE at most) for the
 * poll path. Struct layouts (async event 140 bytes, scan result 92 at offset 48) were measured
 * with the Pico W's toolchain (fixtures/sketches/picow/wifi-layout). The soft-AP isn't modeled.
 */

import type { AccessPointInfo, Level, McuPin, PinMode, WifiLink, WifiRadio } from '@benchtop/core';
import { utf8Bytes, utf8String } from '@benchtop/core';
import type { HleTask, Upcall } from '../hle.ts';

/**
 * BT113: what a handler sees of a call — the Thumb HLE's `Cyw43Call` and @benchtop/riscv's
 * `RiscvHleCall` both are one, so the Pico W (RP2040) and the Pico 2 W (RP2350, RISC-V) share
 * this model.
 */
export interface Cyw43Call {
  /** SCRATCH bytes a generator may use while it runs (0 for a plain handler). */
  readonly scratch: number;
  arg(i: number): number;
  int(i: number): number;
  call(fn: number, ...args: number[]): Upcall;
  read8(address: number): number;
  read16(address: number): number;
  read32(address: number): number;
  write8(address: number, value: number): void;
  write16(address: number, value: number): void;
  write32(address: number, value: number): void;
  readBytes(address: number, length: number): Uint8Array;
  writeBytes(address: number, bytes: ArrayLike<number>): void;
  fill(address: number, length: number, value?: number): void;
  readString(address: number, max?: number): string;
}

/** BT113: an HLE table the model installs its handlers in (either ISA's). */
export interface Cyw43Hle {
  replace(address: number, name: string, handler: (call: Cyw43Call) => number | HleTask): void;
}

/** Raspberry Pi's OUI (28:CD:C1), as on Pico W boards. */
export const PICO_W_MAC = [0x28, 0xcd, 0xc1, 0x00, 0x00, 0x01];

/** The chip's GPIOs (WL_GPIO0 the LED, WL_GPIO1 power save, WL_GPIO2 VBUS sense). */
export const CYW43_GPIOS = 3;

/** cyw43_ll_t is 527 words (cyw43_ll.h CYW43_LL_STATE_SIZE_WORDS): work items are written there. */
export const LL_STATE_BYTES = 527 * 4;

/** The ioctls the model knows (cyw43_ll.h: WLC codes << 1, bit 0 set for a write). */
export const CYW43_IOCTL = { GET_SSID: 0x32, GET_CHANNEL: 0x3a, SET_DISASSOC: 0x69, GET_ANTDIV: 0x7e, SET_ANTDIV: 0x81, SET_MONITOR: 0xd9, GET_RSSI: 0xfe, GET_VAR: 0x20c, SET_VAR: 0x20f } as const;

/** Async event types (cyw43_ll.h CYW43_EV_*). */
export const CYW43_EV = { SET_SSID: 0, JOIN: 1, AUTH: 3, DEAUTH_IND: 6, ASSOC: 7, DISASSOC: 11, LINK: 16, PSK_SUP: 46, ESCAN_RESULT: 69 } as const;

/** cyw43_wifi_join's auth types (cyw43_ll.h CYW43_AUTH_*). */
export const CYW43_AUTH = { OPEN: 0, WPA_TKIP_PSK: 0x00200002, WPA2_AES_PSK: 0x00400004, WPA2_MIXED_PSK: 0x00400006 } as const;

/** cyw43_async_event_t (140 bytes) and cyw43_ev_scan_result_t (92, at EVENT.SCAN): measured (wifi-layout). */
export const EVENT = { SIZE: 140, FLAGS: 2, TYPE: 4, STATUS: 8, REASON: 12, INTERFACE: 46, SCAN: 48 } as const;
export const SCAN_RESULT = { SIZE: 92, BSSID: 20, SSID_LEN: 30, SSID: 31, CHANNEL: 84, AUTH_MODE: 88, RSSI: 90 } as const;
/** cyw43_wifi_scan_options_t (76 bytes): ssid_len and ssid (a scan for one SSID). */
export const SCAN_OPTIONS = { SIZE: 76, SSID_LEN: 8, SSID: 12 } as const;

/** Event statuses: ESCAN partial (one result) and complete; PSK_SUP keyed. */
const STATUS_PARTIAL = 8;
const STATUS_NO_NETWORKS = 3;
const SUP_KEYED = 6;
const SUP_FAILED = 7;

const CHANNELS = 13;
/** Per channel of a scan (and of a join's search), ms. */
export const SCAN_DWELL_MS = 40;
/** Authentication and association once the AP is found, ms. */
const ASSOCIATE_MS = 30;
/** The 4-way handshake after association (WPA/WPA2), ms. */
const HANDSHAKE_MS = 20;
/** A wrong key: the supplicant gives up on the handshake after this, ms. */
export const KEY_TIMEOUT_MS = 1000;
/** An AP gone quiet: the station drops it after this without beacons, ms. */
export const BEACON_LOSS_MS = 6000;
/** Received frames waiting for the poll at most (more are dropped, as the chip's buffers would be). */
const RX_QUEUE = 32;

/** Firmware functions the model calls back (a firmware without them can't run WiFi here). */
export const CYW43_NEEDS = ['cyw43_cb_process_async_event'] as const;

/** An alarm in the board's simulated time. */
export interface Cyw43Alarm {
  schedule(deltaNanos: number): void;
  cancel(): void;
}

/** What the chip needs from its board. */
export interface Cyw43Host {
  /** The chip's MAC (OTP). */
  readonly mac: readonly number[];
  /** Host-wake (GP24) as the chip drives it: high while it has work for the firmware. */
  hostWake(level: boolean): void;
  /** A chip GPIO changed (WL_GPIO0: the LED). */
  gpioChanged(gpio: number, level: boolean): void;
  /** BT111: the board's time, ns, and an alarm on its clock (the clock a reset builds). */
  now(): number;
  createAlarm(callback: () => void): Cyw43Alarm;
  /** BT111: the firmware used something the chip model doesn't do (the soft-AP). */
  unsupported(what: string): void;
  /**
   * BT111: the bus came up — the pins as the real bring-up leaves them (pico_cyw43_driver's
   * cyw43_spi_gpio_setup and cyw43_spi_reset): WL_REG_ON (GP23) driven high, CS (GP25) driven
   * high, GP24 a SIO input with its input enabled — host-wake, which the GPIO interrupt reads.
   */
  busUp(): void;
}

/** Work for the firmware, delivered from `cyw43_ll_process_packets`. */
export type Cyw43Work = { kind: 'event'; bytes: Uint8Array } | { kind: 'frame'; itf: number; bytes: Uint8Array };

/** A join under way or done. */
interface Join {
  ssid: string;
  key: string;
  auth: number;
  bssid: number[] | null;
}

interface Timed {
  at: number;
  gen: number;
  run: () => void;
}

const sameMac = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** cyw43_ev_scan_result_t's auth_mode for a security (cyw43_ll.c: WEP/privacy 1, WPA 2, WPA2 4). */
function authMode(ap: AccessPointInfo): number {
  switch (ap.security) {
    case 'open':
      return 0;
    case 'wep':
      return 1;
    case 'wpa':
      return 3;
    case 'wpa-wpa2':
      return 7;
    default:
      return 5; // WPA2, WPA3 and WPA2/WPA3: an RSN element and privacy
  }
}

/** An async event's bytes as cyw43_ll.c leaves them for cyw43_ctrl.c (host byte order). */
export function eventBytes(type: number, status: number, reason = 0, flags = 0, itf = 0): Uint8Array {
  const bytes = new Uint8Array(EVENT.SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint16(EVENT.FLAGS, flags, true);
  view.setUint32(EVENT.TYPE, type, true);
  view.setUint32(EVENT.STATUS, status >>> 0, true);
  view.setUint32(EVENT.REASON, reason >>> 0, true);
  bytes[EVENT.INTERFACE] = itf;
  return bytes;
}

/** An ESCAN_RESULT partial event carrying one access point. */
export function scanResultBytes(ap: AccessPointInfo): Uint8Array {
  const bytes = eventBytes(CYW43_EV.ESCAN_RESULT, STATUS_PARTIAL);
  const view = new DataView(bytes.buffer);
  const at = EVENT.SCAN;
  bytes.set(ap.bssid, at + SCAN_RESULT.BSSID);
  const ssid = utf8Bytes(ap.ssid).subarray(0, 32);
  bytes[at + SCAN_RESULT.SSID_LEN] = ssid.length;
  bytes.set(ssid, at + SCAN_RESULT.SSID);
  view.setUint16(at + SCAN_RESULT.CHANNEL, ap.channel, true);
  bytes[at + SCAN_RESULT.AUTH_MODE] = authMode(ap);
  view.setInt16(at + SCAN_RESULT.RSSI, Math.round(ap.rssi), true);
  return bytes;
}

export class Cyw43 {
  private readonly host: Cyw43Host;
  /** Firmware functions by name (install). */
  private readonly fn = new Map<string, number>();
  /** The cyw43_ll_t the driver handed cyw43_ll_init, and its callback data (the cyw43_t). */
  private llState = 0;
  private cbData = 0;
  /** The bus came up (cyw43_ll_bus_init) since the last reset. */
  up = false;
  /** WL_GPIO0–2 as the firmware set them. */
  readonly gpio = [false, false, false];
  /** Work waiting for the driver's poll. */
  private readonly queue: Cyw43Work[] = [];
  /** cyw43_ll_* calls answered, by name (tests). */
  readonly calls = new Map<string, number>();
  /** BT111: the bench's radio (setRadio). */
  private radio: WifiRadio | null = null;
  /** The access point the station is associated with (LINK up), and its port on that LAN. */
  associated: AccessPointInfo | null = null;
  private link: WifiLink | null = null;
  /** The last join asked for (rejoin repeats it). */
  private join: Join | null = null;
  /** Timed chip actions; a new join or a reset bumps `gen`, dropping what the old one scheduled. */
  private timeline: Timed[] = [];
  private gen = 0;
  private joinGen = 0;
  private alarm: Cyw43Alarm | null = null;
  /** Frames sent and received (tests), and dropped for a full queue. */
  framesSent = 0;
  framesReceived = 0;
  framesDropped = 0;
  private apReported = false;

  constructor(host: Cyw43Host) {
    this.host = host;
  }

  /** A chip reset (the board's power-on): off, its GPIOs low, nothing queued, off the LAN. */
  reset(): void {
    this.llState = 0;
    this.cbData = 0;
    this.up = false;
    this.queue.length = 0;
    for (let i = 0; i < CYW43_GPIOS; i++) this.gpio[i] = false;
    this.unlink();
    this.associated = null;
    this.join = null;
    this.timeline = [];
    this.gen++;
    this.alarm = null; // it belonged to the old clock
    this.apReported = false;
    this.host.hostWake(false);
  }

  /** The bench's access points and LANs (null: none); an association moves to a rebuilt bench's. */
  setRadio(radio: WifiRadio | null): void {
    this.radio = radio;
    const ap = this.associated;
    if (ap === null || this.link === null) return;
    const now = radio?.accessPoints().find((a) => sameMac(a.bssid, ap.bssid));
    if (now === undefined || !this.linkTo(now)) this.apLost();
  }

  /**
   * Answers the driver's ll layer on `hle` where `lookup` names its functions. Not installed
   * (returns false) when the firmware has no cyw43 driver; `missing` names callbacks it lacks.
   */
  install(hle: Cyw43Hle, lookup: (name: string) => number | undefined): { installed: boolean; missing: string[] } {
    if (lookup('cyw43_ll_bus_init') === undefined) return { installed: false, missing: [] };
    const missing = CYW43_NEEDS.filter((name) => lookup(name) === undefined);
    if (missing.length > 0) return { installed: false, missing };
    this.fn.clear();
    for (const name of CYW43_NEEDS) this.fn.set(name, lookup(name) ?? 0);
    const rx = lookup('__wrap_cyw43_cb_process_ethernet') ?? lookup('cyw43_cb_process_ethernet');
    if (rx !== undefined) this.fn.set('process_ethernet', rx);
    for (const [name, handler] of Object.entries(this.handlers())) {
      const address = lookup(name);
      if (address !== undefined)
        hle.replace(address, name, (call) => {
          this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
          return handler(call);
        });
    }
    return { installed: true, missing: [] };
  }

  /** Queues work for the firmware and raises host-wake. */
  deliver(work: Cyw43Work): void {
    this.queue.push(work);
    this.host.hostWake(true);
  }

  /** Items waiting for the driver's poll (tests). */
  get pending(): number {
    return this.queue.length;
  }

  private handlers(): Record<string, (call: Cyw43Call) => number | HleTask> {
    const ok = (): number => 0;
    const softAp = (): number => {
      if (!this.apReported) {
        this.apReported = true;
        this.host.unsupported("The Pico W's soft access point (WiFi.softAP / AP mode) isn't simulated: only station mode is.");
      }
      return -1;
    };
    return {
      cyw43_ll_init: (call) => {
        this.llState = call.arg(0);
        this.cbData = call.arg(1);
        return 0;
      },
      cyw43_ll_deinit: () => {
        this.up = false;
        this.queue.length = 0;
        this.host.hostWake(false);
        return 0;
      },
      cyw43_ll_bus_init: () => {
        this.up = true;
        this.host.busUp();
        return 0;
      },
      cyw43_ll_bus_sleep: ok,
      cyw43_ll_wifi_on: ok,
      cyw43_ll_wifi_pm: ok,
      cyw43_ll_wifi_get_pm: (call) => {
        // pm, pm_sleep_ret, li_bcn in r1–r3; li_dtim and li_assoc on the stack
        for (let i = 1; i <= 5; i++) call.write32(call.arg(i), 0);
        return 0;
      },
      cyw43_ll_wifi_get_mac: (call) => {
        call.writeBytes(call.arg(1), this.host.mac);
        return 0;
      },
      cyw43_ll_wifi_update_multicast_filter: ok,
      cyw43_ll_gpio_set: (call) => this.gpioSet(call.int(1), call.arg(2) !== 0),
      cyw43_ll_gpio_get: (call) => {
        const n = call.int(1);
        if (n < 0 || n >= CYW43_GPIOS) return -22; // -EINVAL
        call.write8(call.arg(2), this.gpio[n] ? 1 : 0);
        return 0;
      },
      cyw43_ll_ioctl: (call) => this.ioctl(call),
      cyw43_ll_has_work: () => (this.queue.length > 0 ? 1 : 0),
      cyw43_ll_bt_has_work: () => 0,
      cyw43_ll_process_packets: (call) => this.processPackets(call),
      // BT111: the station
      cyw43_ll_wifi_scan: (call) => this.scan(call),
      cyw43_ll_wifi_join: (call) => this.startJoin(call),
      cyw43_ll_wifi_rejoin: () => {
        if (this.join !== null) this.runJoin(this.join);
        return 0;
      },
      cyw43_ll_wifi_set_wpa_auth: ok,
      cyw43_ll_wifi_get_bssid: (call) => {
        if (this.associated === null) return -1;
        call.writeBytes(call.arg(1), this.associated.bssid);
        return 0;
      },
      cyw43_ll_send_ethernet: (call) => this.send(call),
      cyw43_ll_wifi_ap_init: softAp,
      cyw43_ll_wifi_ap_set_up: softAp,
      cyw43_ll_wifi_ap_get_stas: (call) => {
        call.write32(call.arg(1), 0);
        return softAp();
      },
    };
  }

  private gpioSet(n: number, level: boolean): number {
    if (n < 0 || n >= CYW43_GPIOS) return -22;
    if (this.gpio[n] !== level) {
      this.gpio[n] = level;
      this.host.gpioChanged(n, level);
    }
    return 0;
  }

  /** cyw43_ll_ioctl(self, cmd, len, buf, iface): the command is a WLC code << 1, bit 0 set for a write. */
  private ioctl(call: Cyw43Call): number {
    const cmd = call.arg(1);
    const len = call.arg(2);
    const buf = call.arg(3);
    switch (cmd) {
      case CYW43_IOCTL.GET_VAR: {
        if (buf === 0 || len === 0) return 0;
        const name = call.readString(buf, Math.min(len, 64));
        call.fill(buf, Math.min(len, 64));
        if (name === 'cur_etheraddr') call.writeBytes(buf, this.host.mac);
        return 0;
      }
      case CYW43_IOCTL.GET_RSSI:
        if (buf !== 0 && len >= 4) call.write32(buf, this.associated === null ? 0 : Math.round(this.associated.rssi));
        return 0;
      case CYW43_IOCTL.GET_SSID: {
        if (buf === 0 || len < 36) return 0;
        const ssid = utf8Bytes(this.associated?.ssid ?? '').subarray(0, 32);
        call.fill(buf, 36);
        call.write32(buf, ssid.length);
        call.writeBytes(buf + 4, ssid);
        return 0;
      }
      case CYW43_IOCTL.GET_CHANNEL:
        if (buf !== 0 && len >= 12) for (let i = 0; i < 3; i++) call.write32(buf + 4 * i, this.associated?.channel ?? 0);
        return 0;
      case CYW43_IOCTL.SET_DISASSOC:
        this.leave();
        return 0;
      default:
        return 0;
    }
  }

  /** Every queued item to the firmware's callbacks, in order; host-wake drops once none is left. */
  private *processPackets(call: Cyw43Call): HleTask {
    while (this.queue.length > 0) {
      const work = this.queue.shift() as Cyw43Work;
      const at = this.llState;
      if (at === 0 || work.bytes.length > LL_STATE_BYTES) continue;
      call.writeBytes(at, work.bytes);
      if (work.kind === 'event') yield call.call(this.fn.get('cyw43_cb_process_async_event') ?? 0, this.cbData, at);
      else {
        const rx = this.fn.get('process_ethernet');
        if (rx !== undefined) yield call.call(rx, this.cbData, work.itf, work.bytes.length, at);
      }
    }
    this.host.hostWake(false);
    return 0;
  }

  // ── Time ──────────────────────────────────────────────────────────────────────────────

  /** Runs `run` `ms` from now unless a reset (or, with `gen`, a newer join) came first. */
  private after(ms: number, run: () => void, gen = this.gen): void {
    this.timeline.push({ at: this.host.now() + ms * 1e6, gen, run });
    this.arm();
  }

  private arm(): void {
    if (this.timeline.length === 0) {
      this.alarm?.cancel();
      return;
    }
    let next = Infinity;
    for (const t of this.timeline) if (t.at < next) next = t.at;
    this.alarm ??= this.host.createAlarm(() => this.fire());
    this.alarm.cancel();
    this.alarm.schedule(Math.max(0, next - this.host.now()));
  }

  private fire(): void {
    const now = this.host.now();
    const due = this.timeline.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
    this.timeline = this.timeline.filter((t) => t.at > now);
    for (const t of due) if (t.gen === this.gen) t.run();
    this.arm();
  }

  // ── Scan ──────────────────────────────────────────────────────────────────────────────

  /** cyw43_ll_wifi_scan(self, opts): results as the scan reaches each AP's channel, then its end. */
  private scan(call: Cyw43Call): number {
    const opts = call.arg(1);
    let only = '';
    if (opts !== 0) {
      const len = Math.min(32, call.read32(opts + SCAN_OPTIONS.SSID_LEN));
      only = utf8String(call.readBytes(opts + SCAN_OPTIONS.SSID, len));
    }
    const heard = (this.radio?.accessPoints() ?? []).filter((ap) => (only === '' ? !ap.hidden : ap.ssid === only));
    for (const ap of heard) this.after(ap.channel * SCAN_DWELL_MS, () => this.deliver({ kind: 'event', bytes: scanResultBytes(ap) }));
    this.after(CHANNELS * SCAN_DWELL_MS + 1, () => this.deliver({ kind: 'event', bytes: eventBytes(CYW43_EV.ESCAN_RESULT, 0) }));
    return 0;
  }

  // ── Join ──────────────────────────────────────────────────────────────────────────────

  /** cyw43_ll_wifi_join(self, ssid_len, ssid, key_len, key, auth_type, bssid, channel). */
  private startJoin(call: Cyw43Call): number {
    const ssid = utf8String(call.readBytes(call.arg(2), Math.min(32, call.arg(1))));
    const key = utf8String(call.readBytes(call.arg(4), Math.min(64, call.arg(3))));
    const bssidAt = call.arg(6);
    const join: Join = { ssid, key, auth: call.arg(5), bssid: bssidAt === 0 ? null : Array.from(call.readBytes(bssidAt, 6)) };
    this.join = join;
    this.runJoin(join);
    return 0;
  }

  private runJoin(join: Join): void {
    if (this.associated !== null) this.dropLink(false);
    const gen = ++this.joinGen;
    const live = (): boolean => gen === this.joinGen;
    const candidates = (this.radio?.accessPoints() ?? []).filter((ap) => ap.ssid === join.ssid && (join.bssid === null || sameMac(ap.bssid, join.bssid)));
    const protectedJoin = join.auth !== CYW43_AUTH.OPEN;
    // The chip prunes a network whose security the join can't speak: no key for a protected one, a key for an open one.
    const usable = candidates.filter((ap) => (ap.security === 'open') !== protectedJoin).sort((a, b) => b.rssi - a.rssi);
    const ap = usable[0];
    const noNet = (): void => {
      if (live()) this.deliver({ kind: 'event', bytes: eventBytes(CYW43_EV.SET_SSID, STATUS_NO_NETWORKS) });
    };
    if (ap === undefined) {
      this.after(CHANNELS * SCAN_DWELL_MS, noNet);
      return;
    }
    const found = ap.channel * SCAN_DWELL_MS + ASSOCIATE_MS;
    const keyOk = !protectedJoin || join.key === ap.password;
    this.after(found, () => {
      if (!live()) return;
      const now = this.radio?.accessPoints().find((a) => sameMac(a.bssid, ap.bssid));
      if (now === undefined) return noNet();
      this.deliver({ kind: 'event', bytes: eventBytes(CYW43_EV.AUTH, 0) });
      if (!keyOk) {
        this.after(KEY_TIMEOUT_MS, () => {
          if (live()) this.deliver({ kind: 'event', bytes: eventBytes(CYW43_EV.PSK_SUP, SUP_FAILED) });
        });
        return;
      }
      if (!this.linkTo(now)) return noNet();
      this.associated = now;
      this.deliver({ kind: 'event', bytes: eventBytes(CYW43_EV.LINK, 0, 0, 1) });
      this.deliver({ kind: 'event', bytes: eventBytes(CYW43_EV.SET_SSID, 0) });
      if (protectedJoin)
        this.after(HANDSHAKE_MS, () => {
          if (live() && this.associated === now) this.deliver({ kind: 'event', bytes: eventBytes(CYW43_EV.PSK_SUP, SUP_KEYED) });
        });
    });
  }

  /** The SET_DISASSOC ioctl: off the LAN, a join under way cancelled, DISASSOC (link down) reported. */
  private leave(): void {
    this.joinGen++;
    this.dropLink(true);
  }

  /** Off the LAN; `report`: DISASSOC to the driver (link down, its join state cleared). */
  private dropLink(report: boolean): void {
    this.unlink();
    const was = this.associated;
    this.associated = null;
    if (report && was !== null) this.after(1, () => this.deliver({ kind: 'event', bytes: eventBytes(CYW43_EV.DISASSOC, 0) }));
  }

  private linkTo(ap: AccessPointInfo): boolean {
    this.unlink();
    const link =
      this.radio?.join(
        ap.bssid,
        this.host.mac,
        (frame) => this.receive(frame),
        () => this.apLost(),
      ) ?? null;
    this.link = link;
    return link !== null;
  }

  private unlink(): void {
    const link = this.link;
    this.link = null;
    link?.leave();
  }

  /** The AP went off: after BEACON_LOSS_MS without beacons the station drops it. */
  private apLost(): void {
    const ap = this.associated;
    if (ap === null) return;
    this.link = null;
    const gen = this.joinGen;
    this.after(BEACON_LOSS_MS, () => {
      if (this.associated !== ap || gen !== this.joinGen) return;
      this.associated = null;
      this.deliver({ kind: 'event', bytes: eventBytes(CYW43_EV.DISASSOC, 0) });
    });
  }

  // ── Frames ────────────────────────────────────────────────────────────────────────────

  private receive(frame: Uint8Array): void {
    let frames = 0;
    for (const w of this.queue) if (w.kind === 'frame') frames++;
    if (frames >= RX_QUEUE) {
      this.framesDropped++;
      return;
    }
    this.framesReceived++;
    this.deliver({ kind: 'frame', itf: 0, bytes: frame.slice() });
  }

  /** cyw43_ll_send_ethernet(self, itf, len, buf, is_pbuf): a pbuf chain (next @0, payload @4, len @10) when is_pbuf. */
  private send(call: Cyw43Call): number {
    const len = call.arg(2);
    const buf = call.arg(3);
    const isPbuf = call.arg(4) !== 0;
    if (len > 1600 || buf === 0) return -22;
    let frame: Uint8Array;
    if (!isPbuf) frame = call.readBytes(buf, len);
    else {
      frame = new Uint8Array(len);
      let at = 0;
      for (let p = buf, guard = 0; p !== 0 && at < len && guard < 64; p = call.read32(p), guard++) {
        const n = Math.min(call.read16(p + 10), len - at);
        frame.set(call.readBytes(call.read32(p + 4), n), at);
        at += n;
      }
    }
    if (this.link === null) return -5; // -EIO: not associated
    this.framesSent++;
    this.link.send(frame);
    return 0;
  }
}

/** BT110: the CYW43's WL_GPIO0 as an Mcu pin (the Pico W's and Pico 2 W's LED): an output the chip drives. */
export class Cyw43Pin implements McuPin {
  readonly id = 'WL_GPIO0';
  private readonly chip: Cyw43;
  readonly listeners: (() => void)[] = [];
  constructor(chip: Cyw43) {
    this.chip = chip;
  }
  mode(): PinMode {
    return 'output';
  }
  outputLevel(): Level {
    return this.chip.gpio[0] ? 1 : 0;
  }
  setInput(): void {}
  onOutputChange(listener: () => void): void {
    this.listeners.push(listener);
  }
  fire(): void {
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i]();
  }
}
