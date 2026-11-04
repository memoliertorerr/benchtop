/**
 * The ESP32's WiFi driver at its API boundary (BT97; phase 31's decisions in the build plan).
 *
 * Espressif's driver is closed (libnet80211, libpp, libphy): its calibration polls RF registers
 * the simulator doesn't have. So the functions Arduino's WiFi classes, esp_netif and lwIP's glue
 * call into it — `esp_wifi_*` and `esp_wifi_internal_*`, found by name in the firmware's symbols —
 * are answered here through hle/, and everything above them (the WiFi library, esp_netif, the
 * event loop, lwIP) is the firmware's own code. `esp_wifi_init` is replaced whole: it is open
 * source, but all it does is start the closed driver and its supplicant.
 *
 * State is the driver's: mode, the STA and AP configurations, started, the last scan's results.
 * Events reach the firmware as the real driver's do, through `esp_event_post(WIFI_EVENT, …)`:
 * STA_START/STOP and AP_START/STOP from inside esp_wifi_start/stop (the calling task), timed ones
 * (SCAN_DONE, CONNECTED, DISCONNECTED) from the driver's task. esp_wifi_init creates that task
 * (`xTaskCreatePinnedToCore`: "wifi", 4096 bytes, priority 23, core 0 — the real one's) with its
 * entry at WIFI_TASK_PC, which TypeScript answers too: it posts what is due and sleeps a tick
 * (`vTaskDelay(1)`) while WiFi is started, 50 ticks otherwise. Timing: a scan dwells per channel
 * as the scan configuration says (active: `max` where an access point answers, `min` elsewhere;
 * passive: `passive`; IDF's defaults 120 and 360 ms when 0), on all 13 channels or the one given;
 * results come sorted by RSSI, strongest first.
 *
 * What the station sees is the bench's radio (`@benchtop/core` net/, BT98: the wifi-ap parts).
 * STA_CONNECTED joins the AP's LAN as the station's MAC; `esp_wifi_internal_tx(_by_ref)` copies
 * lwIP's frame onto it (the caller keeps its buffer: nothing is referenced or freed later);
 * frames for the station queue up (32 at most) and the WiFi task hands each to lwIP's rx
 * callback in a buffer from `malloc`, which `esp_wifi_internal_free_rx_buffer` gives back with
 * `free`, as the driver's own RX buffers go. An AP that goes off ends the association
 * 6 s later (BEACON_TIMEOUT, the inactive time). A rebuilt bench hands a new radio: an
 * association to an AP still there moves to its new LAN silently.
 *
 * BT116: the soft-AP. While WiFi is started in AP or AP+STA mode the driver hosts an access point
 * on the bench's radio (`hostAp`) from the AP configuration — IDF's default ("ESP_" and the AP
 * MAC's last three bytes, open, channel 1, 4 stations) until `esp_wifi_set_config(WIFI_IF_AP)`,
 * which hosts it again with the new one (an empty SSID: none). Other boards' scans list it and
 * their stations, or client parts, join its LAN; the firmware's own lwIP and DHCP server answer
 * them. A station joining posts AP_STACONNECTED (its MAC and the AID it gets, the lowest free),
 * leaving AP_STADISCONNECTED; `esp_wifi_ap_get_sta_list` lists them; `esp_wifi_deauth_sta` turns
 * them away. Frames for the AP interface queue up beside the station's and go to its rx callback;
 * `esp_wifi_internal_tx(WIFI_IF_AP)` sends on the AP's LAN. Hosting again, or the AP going down,
 * posts AP_STADISCONNECTED for each station first. A rebuilt bench keeps the AP (the runtime hands
 * it on); a reset of the board drops it (`dispose`).
 *
 * Without symbols the firmware's WiFi calls run the real driver into the radio's registers;
 * the Mcu reports that (`esp32-wifi-no-symbols`) the first time it happens.
 */

import type { AccessPointInfo, SoftApConfig, SoftApLink, WifiLink, WifiRadio, WifiSecurity } from '@benchtop/core';
import { type HleTask, SCRATCH_SIZE, type Upcall } from '../hle/hle.ts';
import * as T from './types.ts';

export const CODE_WIFI_NO_SYMBOLS = 'esp32-wifi-no-symbols';
export const CODE_WIFI_UNSUPPORTED = 'esp32-wifi-unsupported';

/** The ESP32's WiFi task entry: the ROM's unused tail, next to hle/'s resume and return addresses. */
export const WIFI_TASK_PC = 0x4006fff8;

/**
 * BT107: what the driver needs from one call of a replaced function — the Xtensa `WifiCall`
 * (hle/) and the RISC-V `RiscvWifiCall` (@benchtop/riscv, the ESP32-C3) both provide it, so one
 * driver serves both chips.
 */
export interface WifiCall {
  /** SCRATCH_SIZE bytes a generator may use while it runs (0 for a plain handler). */
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
}

/** BT107: an HLE table the driver installs its handlers in (either ISA's). */
export interface WifiHle {
  replace(address: number, name: string, handler: (call: WifiCall) => number | HleTask): void;
}

/** Firmware functions (and the WIFI_EVENT base) the driver calls back. */
export const WIFI_NEEDS = ['esp_event_post', 'vTaskDelay', 'xTaskCreatePinnedToCore', 'malloc', 'free', 'WIFI_EVENT'] as const;

/** wifi_auth_mode_t for a radio's security. */
const AUTH_OF: Readonly<Record<WifiSecurity, number>> = {
  open: T.WIFI_AUTH.OPEN,
  wep: T.WIFI_AUTH.WEP,
  wpa: T.WIFI_AUTH.WPA_PSK,
  wpa2: T.WIFI_AUTH.WPA2_PSK,
  'wpa-wpa2': T.WIFI_AUTH.WPA_WPA2_PSK,
  wpa3: T.WIFI_AUTH.WPA3_PSK,
  'wpa2-wpa3': T.WIFI_AUTH.WPA2_WPA3_PSK,
};

/** BT116: a soft-AP's security for IDF's auth mode (WPA2-Enterprise, which the bench lacks, as WPA2). */
const SECURITY_OF: Readonly<Record<number, WifiSecurity>> = {
  [T.WIFI_AUTH.OPEN]: 'open',
  [T.WIFI_AUTH.WEP]: 'wep',
  [T.WIFI_AUTH.WPA_PSK]: 'wpa',
  [T.WIFI_AUTH.WPA2_PSK]: 'wpa2',
  [T.WIFI_AUTH.WPA_WPA2_PSK]: 'wpa-wpa2',
  [T.WIFI_AUTH.WPA2_ENTERPRISE]: 'wpa2',
  [T.WIFI_AUTH.WPA3_PSK]: 'wpa3',
  [T.WIFI_AUTH.WPA2_WPA3_PSK]: 'wpa2-wpa3',
};

/** BT116: the soft-AP's defaults (IDF's): its stations at most, and what the AP hears of each. */
const AP_DEFAULT_STATIONS = 4;
const AP_STATION_RSSI = -45;
const PHY_FLAGS_11BGN = 0b111;
/** Events about the station (dropping it cancels them; the soft-AP's stay). */
const STATION_EVENTS: readonly number[] = [T.WIFI_EVENT.SCAN_DONE, T.WIFI_EVENT.STA_CONNECTED, T.WIFI_EVENT.STA_DISCONNECTED];

/** An access point as the driver sees it: the radio's, with IDF's auth mode. */
interface VirtualAp extends AccessPointInfo {
  auth: number;
}

export interface WifiHost {
  /** The SoC's time, in reference cycles. */
  now(): number;
  readonly refHz: number;
  /** The chip's base MAC (eFuse): the station's; the soft-AP's is one more. */
  readonly mac: readonly number[];
  /** The bench's radio, or null (no access point anywhere). */
  radio(): WifiRadio | null;
  /** BT107: where the WiFi task's entry is (an address the firmware never executes; default WIFI_TASK_PC, the ESP32's). */
  readonly taskPc?: number;
  /** BT107: sizeof(wifi_sta_list_t) on this chip (default STA_LIST.SIZE, the ESP32's; the C3's is STA_LIST_C3.SIZE). */
  readonly staListSize?: number;
}

/** Frames waiting for lwIP at most (more are dropped, as the driver's RX buffers would be). */
const RX_QUEUE = 32;
/** A station that stops hearing its AP gives up after the inactive time (IDF's default 6 s). */
const BEACON_LOSS_MS = 6000;

interface Pending {
  at: number;
  id: number;
  data: Uint8Array | null;
  /** Runs as the event comes due; false: don't post it (something else happened). */
  apply: (() => boolean) | null;
}

const CHANNELS = 13;
const ACTIVE_DEFAULT_MS = 120;
const PASSIVE_DEFAULT_MS = 360;
/** Authentication + association after the AP is found. */
const ASSOCIATE_MS = 30;
/** WPA2's 4-way handshake timing out on a wrong password (the station's own retries). */
const HANDSHAKE_FAIL_MS = 4000;
const TASK_NAME = [0x77, 0x69, 0x66, 0x69, 0]; // "wifi"
const CIPHER_NONE = 0;
const CIPHER_WEP40 = 1;
const CIPHER_CCMP = 4;
const PHY_11BGN = 0b111;

/** An auth mode's strength (esp_wifi_types.h: OPEN < WEP < WPA < WPA2 = WPA/WPA2 = WPA2/WPA3 < WPA3). */
function strength(auth: number): number {
  switch (auth) {
    case T.WIFI_AUTH.OPEN:
      return 0;
    case T.WIFI_AUTH.WEP:
      return 1;
    case T.WIFI_AUTH.WPA_PSK:
      return 2;
    case T.WIFI_AUTH.WPA3_PSK:
      return 4;
    default:
      return 3;
  }
}

/** UTF-8 bytes (packages are DOM-free: no TextEncoder in their typings). */
export function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** A NUL-terminated (or full) byte field as a string (UTF-8). */
function cString(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && bytes[end] !== 0) end++;
  let out = '';
  for (let i = offset; i < end; ) {
    const b = bytes[i];
    const n = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    let c = n === 1 ? b : b & (0xff >> (n + 1));
    for (let k = 1; k < n && i + k < end; k++) c = (c << 6) | (bytes[i + k] & 63);
    out += String.fromCodePoint(c);
    i += n;
  }
  return out;
}

export class WifiDriver {
  mode: number = T.WIFI_MODE.NULL;
  inited = false;
  started = false;
  scanning = false;
  /** The access point the station is associated with. */
  associated: VirtualAp | null = null;
  readonly staConfig = new Uint8Array(T.STA_CONFIG.SIZE);
  readonly apConfig = new Uint8Array(T.AP_CONFIG.SIZE);
  /** The last scan's results, until esp_wifi_scan_get_ap_records takes them. */
  scanResults: VirtualAp[] = [];
  /** The reason of the last STA_DISCONNECTED posted (0: none yet). */
  lastReason = 0;
  /** Frames lwIP handed the driver to send, frames handed to lwIP, frames dropped (a full queue, no buffer). */
  framesOut = 0;
  framesIn = 0;
  framesDropped = 0;
  /** lwIP's receive functions per interface (esp_wifi_internal_reg_rxcb). */
  readonly rxCallbacks = [0, 0];
  /** BT116: the soft-AP's stations, in joining order, with the association ids it gave them. */
  readonly apStations: { mac: number[]; aid: number }[] = [];
  /** BT116: the soft-AP on the bench while it is up (null: not hosting). */
  private softAp: SoftApLink | null = null;
  /** Bumped whenever the soft-AP is closed or hosted again: an old one's callbacks do nothing. */
  private apGeneration = 0;
  private readonly apRxQueue: Uint8Array[] = [];
  private readonly host: WifiHost;
  private readonly fn = new Map<string, number>();
  private readonly pending: Pending[] = [];
  private readonly macs: number[][];
  private link: WifiLink | null = null;
  private readonly rxQueue: Uint8Array[] = [];
  private taskCreated = false;
  private connecting = false;
  private scanId = 0;
  private ps = 1;
  private maxTxPower = 80;
  private readonly bandwidth = [2, 2];
  private readonly protocol = [7, 7];

  constructor(host: WifiHost) {
    this.host = host;
    const sta = [...host.mac];
    const ap = [...host.mac];
    ap[5] = (ap[5] + 1) & 0xff;
    this.macs = [sta, ap];
  }

  /**
   * Replaces the driver's API in `hle` by the functions `lookup` finds. Not a WiFi firmware (no
   * esp_wifi_init): nothing to do. Returns the needed firmware names it lacks (then nothing is
   * replaced).
   */
  install(hle: WifiHle, lookup: (name: string) => number | undefined): { installed: boolean; missing: string[] } {
    if (lookup('esp_wifi_init') === undefined) return { installed: false, missing: [] };
    const missing = WIFI_NEEDS.filter((name) => lookup(name) === undefined);
    if (missing.length > 0) return { installed: false, missing };
    for (const name of WIFI_NEEDS) this.fn.set(name, lookup(name) ?? 0);
    for (const [name, handler] of Object.entries(this.handlers())) {
      const address = lookup(name);
      if (address !== undefined) hle.replace(address, name, handler);
    }
    hle.replace(this.host.taskPc ?? WIFI_TASK_PC, 'wifi task', (call) => this.task(call));
    return { installed: true, missing: [] };
  }

  private address(name: (typeof WIFI_NEEDS)[number]): number {
    return this.fn.get(name) ?? 0;
  }

  private handlers(): Record<string, (call: WifiCall) => number | HleTask> {
    const ok = (): number => T.ESP_OK;
    const initOk = (): number => (this.inited ? T.ESP_OK : T.ESP_ERR_WIFI_NOT_INIT);
    return {
      esp_wifi_init: (call) => this.init(call),
      esp_wifi_deinit: () => this.deinit(),
      esp_wifi_set_mode: (call) => this.setMode(call),
      esp_wifi_get_mode: (call) => this.out32(call, 0, this.mode),
      esp_wifi_start: (call) => this.start(call),
      esp_wifi_stop: (call) => this.stop(call),
      esp_wifi_restore: ok,
      esp_wifi_set_storage: initOk,
      esp_wifi_set_config: (call) => this.setConfig(call),
      esp_wifi_get_config: (call) => this.getConfig(call),
      esp_wifi_set_mac: (call) => this.setMac(call),
      esp_wifi_get_mac: (call) => this.getMac(call),
      esp_wifi_scan_start: (call) => this.scanStart(call),
      esp_wifi_scan_stop: () => this.scanStop(),
      esp_wifi_scan_get_ap_num: (call) => this.out16(call, 0, this.scanResults.length),
      esp_wifi_scan_get_ap_records: (call) => this.apRecords(call),
      esp_wifi_clear_ap_list: () => {
        this.scanResults = [];
        return T.ESP_OK;
      },
      esp_wifi_connect: (call) => this.connect(call),
      esp_wifi_disconnect: (call) => this.disconnect(call),
      esp_wifi_sta_get_ap_info: (call) => this.apInfo(call),
      esp_wifi_set_ps: (call) => {
        this.ps = call.arg(0);
        return T.ESP_OK;
      },
      esp_wifi_get_ps: (call) => this.out32(call, 0, this.ps),
      esp_wifi_set_protocol: (call) => this.perInterface(call, this.protocol),
      esp_wifi_get_protocol: (call) => (call.arg(0) > 1 ? T.ESP_ERR_WIFI_IF : this.out8(call, 1, this.protocol[call.arg(0)])),
      esp_wifi_set_bandwidth: (call) => this.perInterface(call, this.bandwidth),
      esp_wifi_get_bandwidth: (call) => (call.arg(0) > 1 ? T.ESP_ERR_WIFI_IF : this.out32(call, 1, this.bandwidth[call.arg(0)])),
      esp_wifi_set_channel: initOk,
      esp_wifi_get_channel: (call) => this.getChannel(call),
      esp_wifi_set_country: initOk,
      esp_wifi_get_country: (call) => this.getCountry(call),
      esp_wifi_set_max_tx_power: (call) => {
        this.maxTxPower = Math.max(8, Math.min(84, call.int(0) << 24 >> 24));
        return initOk();
      },
      esp_wifi_get_max_tx_power: (call) => this.out8(call, 0, this.maxTxPower),
      esp_wifi_ap_get_sta_list: (call) => this.staList(call),
      esp_wifi_ap_get_sta_aid: (call) => this.staAid(call),
      esp_wifi_deauth_sta: (call) => this.deauth(call),
      esp_wifi_set_ant_gpio: ok,
      esp_wifi_get_ant_gpio: ok,
      esp_wifi_set_ant: ok,
      esp_wifi_get_ant: ok,
      esp_wifi_set_event_mask: ok,
      esp_wifi_set_promiscuous: ok,
      esp_wifi_ftm_initiate_session: () => T.ESP_ERR_NOT_SUPPORTED,
      esp_wifi_internal_reg_rxcb: (call) => this.regRx(call),
      esp_wifi_internal_tx: (call) => this.transmit(call),
      esp_wifi_internal_tx_by_ref: (call) => this.transmit(call),
      esp_wifi_internal_free_rx_buffer: (call) => this.freeRx(call),
      esp_wifi_internal_reg_netstack_buf_cb: ok,
      esp_wifi_internal_set_sta_ip: ok,
      esp_wifi_internal_set_log_level: ok,
    };
  }

  // ── Calls back into the firmware ──────────────────────────────────────────────────────

  /** esp_event_post(WIFI_EVENT, id, data, size, portMAX_DELAY); `data` goes through the frame's scratch. */
  private *post(call: WifiCall, id: number, data: Uint8Array | null): Generator<Upcall, number, number> {
    const base = call.read32(this.address('WIFI_EVENT'));
    if (id === T.WIFI_EVENT.STA_DISCONNECTED && data !== null) this.lastReason = data[T.STA_DISCONNECTED.REASON];
    if (data !== null) call.writeBytes(call.scratch, data.subarray(0, SCRATCH_SIZE));
    return yield call.call(this.address('esp_event_post'), base, id, data === null ? 0 : call.scratch, data === null ? 0 : data.length, T.PORT_MAX_DELAY);
  }

  /** The WiFi task: posts what is due, hands lwIP the frames that came, sleeps a tick (50 while WiFi is stopped). */
  private *task(call: WifiCall): HleTask {
    for (;;) {
      for (let event = this.due(); event !== null; event = this.due()) {
        if (event.apply !== null && !event.apply()) continue;
        yield* this.post(call, event.id, event.data);
      }
      yield* this.deliver(call, this.rxQueue, T.WIFI_IF.STA, () => this.link !== null);
      yield* this.deliver(call, this.apRxQueue, T.WIFI_IF.AP, () => this.softAp !== null);
      yield call.call(this.address('vTaskDelay'), this.started || this.pending.length > 0 ? 1 : 50);
    }
  }

  /** Hands lwIP an interface's queued frames, each in a buffer from `malloc` (BT116: the AP's too). */
  private *deliver(call: WifiCall, queue: Uint8Array[], ifx: number, up: () => boolean): Generator<Upcall, void, number> {
    for (let frame = queue.shift(); frame !== undefined; frame = queue.shift()) {
      const receive = this.rxCallbacks[ifx];
      if (receive === 0 || !up()) {
        this.framesDropped++;
        continue;
      }
      const buffer = yield call.call(this.address('malloc'), frame.length);
      if (buffer === 0) {
        this.framesDropped++;
        continue;
      }
      call.writeBytes(buffer, frame);
      this.framesIn++;
      yield call.call(receive, buffer, frame.length, buffer);
    }
  }

  private due(): Pending | null {
    const now = this.host.now();
    let best = -1;
    for (let i = 0; i < this.pending.length; i++) if (this.pending[i].at <= now && (best < 0 || this.pending[i].at < this.pending[best].at)) best = i;
    return best < 0 ? null : (this.pending.splice(best, 1)[0] ?? null);
  }

  private schedule(ms: number, id: number, data: Uint8Array | null, apply: (() => boolean) | null = null): void {
    this.pending.push({ at: this.host.now() + (ms / 1000) * this.host.refHz, id, data, apply });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────────────

  private *init(call: WifiCall): HleTask {
    if (this.inited) return T.ESP_OK;
    if (!this.taskCreated) {
      call.writeBytes(call.scratch, TASK_NAME);
      const created = yield call.call(this.address('xTaskCreatePinnedToCore'), this.host.taskPc ?? WIFI_TASK_PC, call.scratch, 4096, 0, 23, 0, 0);
      if (created !== 1) return T.ESP_ERR_NO_MEM;
      this.taskCreated = true;
    }
    if (this.apConfig.every((b) => b === 0)) this.defaultApConfig();
    this.inited = true;
    return T.ESP_OK;
  }

  /** BT116: IDF's soft-AP configuration before any is set: "ESP_XXXXXX" (the AP MAC's last bytes), open, channel 1. */
  private defaultApConfig(): void {
    const C = T.AP_CONFIG;
    const mac = this.macs[T.WIFI_IF.AP];
    const ssid = utf8(`ESP_${mac.slice(3).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('')}`);
    this.apConfig.fill(0);
    this.apConfig.set(ssid, C.SSID);
    this.apConfig[C.SSID_LEN] = ssid.length;
    this.apConfig[C.CHANNEL] = 1;
    this.apConfig[C.MAX_CONNECTION] = AP_DEFAULT_STATIONS;
    this.apConfig[C.BEACON_INTERVAL] = 100;
  }

  private deinit(): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if (this.started) return T.ESP_ERR_WIFI_NOT_STOPPED;
    this.inited = false;
    return T.ESP_OK;
  }

  private setMode(call: WifiCall): number | HleTask {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    const mode = call.arg(0);
    if (mode > T.WIFI_MODE.APSTA) return T.ESP_ERR_INVALID_ARG;
    const before = this.mode;
    this.mode = mode;
    if (!this.started || mode === before) return T.ESP_OK;
    // Started: interfaces come and go with their events, as the driver starts or stops them.
    return this.modeEvents(call, before, mode);
  }

  private *modeEvents(call: WifiCall, before: number, after: number): HleTask {
    if ((before & 1) !== 0 && (after & 1) === 0) {
      this.dropStation();
      yield* this.post(call, T.WIFI_EVENT.STA_STOP, null);
    }
    if ((before & 2) !== 0 && (after & 2) === 0) {
      // BT116: the soft-AP goes down: its stations are told off first.
      for (const station of this.closeAp()) yield* this.post(call, T.WIFI_EVENT.AP_STADISCONNECTED, this.apStaData(station));
      yield* this.post(call, T.WIFI_EVENT.AP_STOP, null);
    }
    if ((before & 1) === 0 && (after & 1) !== 0) yield* this.post(call, T.WIFI_EVENT.STA_START, null);
    if ((before & 2) === 0 && (after & 2) !== 0) {
      yield* this.post(call, T.WIFI_EVENT.AP_START, null);
      this.hostAp();
    }
    return T.ESP_OK;
  }

  private *start(call: WifiCall): HleTask {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if (this.started) return T.ESP_OK;
    this.started = true;
    yield* this.modeEvents(call, T.WIFI_MODE.NULL, this.mode);
    return T.ESP_OK;
  }

  private *stop(call: WifiCall): HleTask {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if (!this.started) return T.ESP_OK;
    yield* this.modeEvents(call, this.mode, T.WIFI_MODE.NULL);
    this.started = false;
    this.pending.length = 0;
    this.scanning = false;
    return T.ESP_OK;
  }

  /** The station leaves whatever it was doing (no event: the caller posts one if due). */
  private dropStation(): void {
    this.associated = null;
    this.connecting = false;
    this.scanning = false;
    for (let i = this.pending.length - 1; i >= 0; i--) if (STATION_EVENTS.includes(this.pending[i].id)) this.pending.splice(i, 1);
    this.unlink();
  }

  private unlink(): void {
    this.link?.leave();
    this.link = null;
    this.rxQueue.length = 0;
  }

  /** Joins `ap`'s LAN (`fresh`: leaving the current one first); false when it is gone. */
  private linkTo(ap: AccessPointInfo, fresh = true): boolean {
    if (fresh) this.unlink();
    this.rxQueue.length = 0;
    const link =
      this.host.radio()?.join(
        ap.bssid,
        this.macs[T.WIFI_IF.STA],
        (frame) => {
          if (this.rxQueue.length < RX_QUEUE) this.rxQueue.push(frame);
          else this.framesDropped++;
        },
        () => this.apLost(),
      ) ?? null;
    this.link = link;
    return link !== null;
  }

  /** The AP went off: after the inactive time without beacons, the station gives up. */
  private apLost(): void {
    const ap = this.associated;
    if (ap === null) return;
    this.link = null;
    this.rxQueue.length = 0;
    const ssid = cString(this.staConfig, T.STA_CONFIG.SSID, 32);
    this.schedule(BEACON_LOSS_MS, T.WIFI_EVENT.STA_DISCONNECTED, this.disconnectedData(ssid, ap, T.WIFI_REASON.BEACON_TIMEOUT), () => {
      if (this.associated !== ap) return false;
      this.associated = null;
      return true;
    });
  }

  /**
   * A rebuilt bench's radio: an association moves to the same AP's new LAN without a word (BT116:
   * joined there before leaving the old one, so a soft-AP the rebuild kept hears nothing); if that
   * AP is gone, it is lost as if switched off. A soft-AP the bench closed meanwhile is hosted again.
   */
  radioChanged(): void {
    if (this.softAp === null && this.started && (this.mode & 2) !== 0) this.hostAp();
    const ap = this.associated;
    const old = this.link;
    if (ap === null || old === null) return;
    const now = this.host.radio()?.accessPoints().find((a) => a.bssid.every((b, i) => b === ap.bssid[i]));
    this.link = null;
    if (now === undefined || !this.linkTo(now, false)) {
      old.leave();
      this.apLost();
      return;
    }
    old.leave();
  }

  /** BT116: the board is gone (a reset builds a new driver): off the AP it was on, its soft-AP closed. */
  dispose(): void {
    this.unlink();
    this.closeAp();
    this.pending.length = 0;
  }

  // ── Configuration ─────────────────────────────────────────────────────────────────────

  private setConfig(call: WifiCall): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    const ifx = call.arg(0);
    if (ifx > 1) return T.ESP_ERR_WIFI_IF;
    if ((this.mode & (ifx === T.WIFI_IF.STA ? 1 : 2)) === 0) return T.ESP_ERR_WIFI_MODE;
    if (call.arg(1) === 0) return T.ESP_ERR_INVALID_ARG;
    const target = ifx === T.WIFI_IF.STA ? this.staConfig : this.apConfig;
    target.set(call.readBytes(call.arg(1), target.length));
    if (ifx === T.WIFI_IF.AP && this.started) {
      // BT116: the soft-AP takes the new configuration at once: its stations are dropped.
      for (const station of this.closeAp()) this.schedule(0, T.WIFI_EVENT.AP_STADISCONNECTED, this.apStaData(station));
      this.hostAp();
    }
    return T.ESP_OK;
  }

  private getConfig(call: WifiCall): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    const ifx = call.arg(0);
    if (ifx > 1) return T.ESP_ERR_WIFI_IF;
    if (call.arg(1) === 0) return T.ESP_ERR_INVALID_ARG;
    call.writeBytes(call.arg(1), ifx === T.WIFI_IF.STA ? this.staConfig : this.apConfig);
    return T.ESP_OK;
  }

  private setMac(call: WifiCall): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    const ifx = call.arg(0);
    if (ifx > 1) return T.ESP_ERR_WIFI_IF;
    const mac = [...call.readBytes(call.arg(1), 6)];
    if ((mac[0] & 1) !== 0) return T.ESP_ERR_INVALID_ARG; // multicast
    this.macs[ifx] = mac;
    return T.ESP_OK;
  }

  private getMac(call: WifiCall): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    const ifx = call.arg(0);
    if (ifx > 1) return T.ESP_ERR_WIFI_IF;
    if (call.arg(1) === 0) return T.ESP_ERR_INVALID_ARG;
    call.writeBytes(call.arg(1), this.macs[ifx]);
    return T.ESP_OK;
  }

  private perInterface(call: WifiCall, store: number[]): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if (call.arg(0) > 1) return T.ESP_ERR_WIFI_IF;
    store[call.arg(0)] = call.arg(1);
    return T.ESP_OK;
  }

  private getChannel(call: WifiCall): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if (call.arg(0) !== 0) call.write8(call.arg(0), this.associated?.channel ?? (this.softAp !== null ? this.softApConfig()?.channel ?? 1 : 1));
    if (call.arg(1) !== 0) call.write32(call.arg(1), 0);
    return T.ESP_OK;
  }

  private getCountry(call: WifiCall): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    const at = call.arg(0);
    if (at === 0) return T.ESP_ERR_INVALID_ARG;
    call.fill(at, T.COUNTRY.SIZE);
    call.writeBytes(at + T.COUNTRY.CC, [0x43, 0x4e, 0x20]); // "CN ", Arduino-ESP32's default
    call.write8(at + T.COUNTRY.SCHAN, 1);
    call.write8(at + T.COUNTRY.NCHAN, CHANNELS);
    call.write8(at + T.COUNTRY.MAX_TX_POWER, 20);
    return T.ESP_OK;
  }

  /** esp_wifi_ap_get_sta_list: the soft-AP's stations (11b/g/n, the RSSI the AP hears), then their number. */
  private staList(call: WifiCall): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if ((this.mode & 2) === 0) return T.ESP_ERR_WIFI_MODE;
    const at = call.arg(0);
    if (at === 0) return T.ESP_ERR_INVALID_ARG;
    const size = this.host.staListSize ?? T.STA_LIST.SIZE;
    call.fill(at, size);
    const n = Math.min(this.apStations.length, (size - 4) / T.STA_INFO.SIZE);
    for (let i = 0; i < n; i++) {
      const entry = at + i * T.STA_INFO.SIZE;
      call.writeBytes(entry + T.STA_INFO.MAC, this.apStations[i].mac);
      call.write8(entry + T.STA_INFO.RSSI, AP_STATION_RSSI & 0xff);
      call.write32(entry + T.STA_INFO.FLAGS, PHY_FLAGS_11BGN);
    }
    call.write32(at + size - 4, n);
    return T.ESP_OK;
  }

  /** esp_wifi_ap_get_sta_aid(mac, &aid). */
  private staAid(call: WifiCall): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if ((this.mode & 2) === 0) return T.ESP_ERR_WIFI_MODE;
    if (call.arg(0) === 0 || call.arg(1) === 0) return T.ESP_ERR_INVALID_ARG;
    const mac = [...call.readBytes(call.arg(0), 6)];
    const station = this.apStations.find((s) => s.mac.every((b, i) => b === mac[i]));
    if (station === undefined) return T.ESP_ERR_NOT_FOUND;
    call.write16(call.arg(1), station.aid);
    return T.ESP_OK;
  }

  /** esp_wifi_deauth_sta(aid): turns a station away (0: every one); AP_STADISCONNECTED follows from `left`. */
  private deauth(call: WifiCall): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if (!this.started) return T.ESP_ERR_WIFI_NOT_STARTED;
    if ((this.mode & 2) === 0) return T.ESP_ERR_WIFI_MODE;
    const aid = call.arg(0) & 0xffff;
    const link = this.softAp;
    if (link === null) return T.ESP_OK;
    for (const station of [...this.apStations]) if (aid === 0 || station.aid === aid) link.drop(station.mac);
    return T.ESP_OK;
  }

  // ── The soft-AP (BT116) ───────────────────────────────────────────────────────────────

  /** The AP configuration as the bench's soft-AP takes it; null for an empty SSID (nothing to host). */
  private softApConfig(): SoftApConfig | null {
    const C = T.AP_CONFIG;
    const c = this.apConfig;
    const length = c[C.SSID_LEN];
    const ssid = cString(c, C.SSID, length > 0 && length <= 32 ? length : 32);
    if (ssid === '') return null;
    const auth = (c[C.AUTHMODE] | (c[C.AUTHMODE + 1] << 8) | (c[C.AUTHMODE + 2] << 16) | (c[C.AUTHMODE + 3] << 24)) >>> 0;
    const security = SECURITY_OF[auth] ?? 'wpa2';
    const channel = c[C.CHANNEL] >= 1 && c[C.CHANNEL] <= CHANNELS ? c[C.CHANNEL] : 1;
    const most = ((this.host.staListSize ?? T.STA_LIST.SIZE) - 4) / T.STA_INFO.SIZE;
    const maxStations = c[C.MAX_CONNECTION] === 0 ? AP_DEFAULT_STATIONS : Math.min(c[C.MAX_CONNECTION], most);
    return { ssid, password: security === 'open' ? '' : cString(c, C.PASSWORD, 64), security, channel, hidden: c[C.SSID_HIDDEN] !== 0, maxStations };
  }

  /** Hosts the soft-AP on the bench's radio from the AP configuration (none without a radio that hosts, or an SSID). */
  private hostAp(): void {
    this.closeAp();
    const config = this.softApConfig();
    const radio = this.host.radio();
    if (config === null || radio?.hostAp === undefined) return;
    const generation = this.apGeneration;
    const mine = (): boolean => generation === this.apGeneration;
    this.softAp =
      radio.hostAp(config, this.macs[T.WIFI_IF.AP], {
        receive: (frame) => {
          if (!mine()) return;
          if (this.apRxQueue.length < RX_QUEUE) this.apRxQueue.push(frame);
          else this.framesDropped++;
        },
        joined: (mac) => {
          if (!mine()) return;
          let aid = 1;
          while (this.apStations.some((s) => s.aid === aid)) aid++;
          const station = { mac: [...mac], aid };
          this.apStations.push(station);
          this.schedule(0, T.WIFI_EVENT.AP_STACONNECTED, this.apStaData(station));
        },
        left: (mac) => {
          if (!mine()) return;
          const i = this.apStations.findIndex((s) => s.mac.every((b, k) => b === mac[k]));
          if (i < 0) return;
          const [station] = this.apStations.splice(i, 1);
          this.schedule(0, T.WIFI_EVENT.AP_STADISCONNECTED, this.apStaData(station));
        },
        closed: () => {
          if (!mine()) return;
          this.apGeneration++;
          this.softAp = null;
          this.apStations.length = 0;
          this.apRxQueue.length = 0;
        },
      }) ?? null;
  }

  /** Closes the soft-AP; returns the stations it had (the caller says whether they hear of it). */
  private closeAp(): { mac: number[]; aid: number }[] {
    const link = this.softAp;
    const stations = this.apStations.splice(0);
    this.apGeneration++;
    this.softAp = null;
    this.apRxQueue.length = 0;
    link?.close();
    return stations;
  }

  /** wifi_event_ap_staconnected_t / _stadisconnected_t. */
  private apStaData(station: { mac: number[]; aid: number }): Uint8Array {
    const data = new Uint8Array(T.AP_STA_EVENT.SIZE);
    data.set(station.mac, T.AP_STA_EVENT.MAC);
    data[T.AP_STA_EVENT.AID] = station.aid;
    return data;
  }

  private out32(call: WifiCall, arg: number, value: number): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if (call.arg(arg) === 0) return T.ESP_ERR_INVALID_ARG;
    call.write32(call.arg(arg), value);
    return T.ESP_OK;
  }

  private out16(call: WifiCall, arg: number, value: number): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if (call.arg(arg) === 0) return T.ESP_ERR_INVALID_ARG;
    call.write16(call.arg(arg), value);
    return T.ESP_OK;
  }

  private out8(call: WifiCall, arg: number, value: number): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if (call.arg(arg) === 0) return T.ESP_ERR_INVALID_ARG;
    call.write8(call.arg(arg), value);
    return T.ESP_OK;
  }

  // ── Scanning ──────────────────────────────────────────────────────────────────────────

  private scanStart(call: WifiCall): number | HleTask {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if (!this.started) return T.ESP_ERR_WIFI_NOT_STARTED;
    if ((this.mode & 1) === 0) return T.ESP_ERR_WIFI_MODE;
    if (this.scanning || this.connecting) return T.ESP_ERR_WIFI_STATE;
    const config = call.arg(0);
    let channel = 0;
    let ssid: string | null = null;
    let showHidden = false;
    let passive = false;
    let minMs = 0;
    let maxMs = 0;
    let passiveMs = 0;
    if (config !== 0) {
      const ssidAt = call.read32(config + T.SCAN_CONFIG.SSID);
      if (ssidAt !== 0) ssid = cString(call.readBytes(ssidAt, 33), 0, 33);
      channel = call.read8(config + T.SCAN_CONFIG.CHANNEL);
      showHidden = call.read8(config + T.SCAN_CONFIG.SHOW_HIDDEN) !== 0;
      passive = call.read32(config + T.SCAN_CONFIG.SCAN_TYPE) === 1;
      minMs = call.read32(config + T.SCAN_CONFIG.ACTIVE_MIN);
      maxMs = call.read32(config + T.SCAN_CONFIG.ACTIVE_MAX);
      passiveMs = call.read32(config + T.SCAN_CONFIG.PASSIVE);
    }
    if (channel > CHANNELS) return T.ESP_ERR_INVALID_ARG;
    const found = this.accessPoints()
      .filter((ap) => (channel === 0 || ap.channel === channel) && (ssid === null || ap.ssid === ssid) && (!ap.hidden || showHidden || ssid !== null))
      .sort((a, b) => b.rssi - a.rssi);
    const max = maxMs === 0 ? ACTIVE_DEFAULT_MS : maxMs;
    const min = minMs === 0 || minMs > max ? max : minMs;
    let ms = 0;
    for (let c = 1; c <= CHANNELS; c++) {
      if (channel !== 0 && c !== channel) continue;
      ms += passive ? (passiveMs === 0 ? PASSIVE_DEFAULT_MS : passiveMs) : found.some((ap) => ap.channel === c) ? max : min;
    }
    this.scanning = true;
    const data = new Uint8Array(T.SCAN_DONE.SIZE);
    data[T.SCAN_DONE.NUMBER] = Math.min(found.length, 255);
    data[T.SCAN_DONE.SCAN_ID] = this.scanId = (this.scanId + 1) & 0xff;
    const done = (): boolean => {
      this.scanning = false;
      this.scanResults = found;
      return true;
    };
    if ((call.arg(1) & 0xff) === 0) {
      this.schedule(ms, T.WIFI_EVENT.SCAN_DONE, data, done);
      return T.ESP_OK;
    }
    return this.scanBlocking(call, ms, data, done);
  }

  /** A blocking scan: the calling task sleeps for the scan, then SCAN_DONE is posted from it. */
  private *scanBlocking(call: WifiCall, ms: number, data: Uint8Array, done: () => boolean): HleTask {
    yield call.call(this.address('vTaskDelay'), Math.max(1, Math.ceil((ms * T.TICK_HZ) / 1000)));
    done();
    yield* this.post(call, T.WIFI_EVENT.SCAN_DONE, data);
    return T.ESP_OK;
  }

  private scanStop(): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if (this.scanning) {
      this.scanning = false;
      for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i].id === T.WIFI_EVENT.SCAN_DONE) this.pending.splice(i, 1);
    }
    return T.ESP_OK;
  }

  private apRecords(call: WifiCall): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    const numberAt = call.arg(0);
    const records = call.arg(1);
    if (numberAt === 0) return T.ESP_ERR_INVALID_ARG;
    const n = Math.min(call.read16(numberAt), this.scanResults.length);
    if (n > 0 && records === 0) return T.ESP_ERR_INVALID_ARG;
    for (let i = 0; i < n; i++) this.writeRecord(call, records + i * T.AP_RECORD.SIZE, this.scanResults[i]);
    call.write16(numberAt, n);
    this.scanResults = []; // the driver frees its list once the records are taken
    return T.ESP_OK;
  }

  private writeRecord(call: WifiCall, at: number, ap: VirtualAp): void {
    const R = T.AP_RECORD;
    call.fill(at, R.SIZE);
    call.writeBytes(at + R.BSSID, ap.bssid.slice(0, 6));
    call.writeBytes(at + R.SSID, utf8(ap.ssid).slice(0, 32));
    call.write8(at + R.PRIMARY, ap.channel);
    call.write8(at + R.RSSI, ap.rssi);
    call.write32(at + R.AUTHMODE, ap.auth);
    const cipher = ap.auth === T.WIFI_AUTH.OPEN ? CIPHER_NONE : ap.auth === T.WIFI_AUTH.WEP ? CIPHER_WEP40 : CIPHER_CCMP;
    call.write32(at + R.PAIRWISE, cipher);
    call.write32(at + R.GROUP, cipher);
    call.write32(at + R.PHY, PHY_11BGN);
    call.writeBytes(at + R.COUNTRY, [0x43, 0x4e, 0x20, 1, CHANNELS, 20]);
  }

  // ── The station ───────────────────────────────────────────────────────────────────────

  private connect(_call: WifiCall): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if (!this.started) return T.ESP_ERR_WIFI_NOT_STARTED;
    if ((this.mode & 1) === 0) return T.ESP_ERR_WIFI_MODE;
    if (this.scanning) return T.ESP_ERR_WIFI_STATE;
    const config = this.staConfig;
    const ssid = cString(config, T.STA_CONFIG.SSID, 32);
    const password = cString(config, T.STA_CONFIG.PASSWORD, 64);
    const channel = config[T.STA_CONFIG.CHANNEL];
    const bssid = config[T.STA_CONFIG.BSSID_SET] !== 0 ? [...config.subarray(T.STA_CONFIG.BSSID, T.STA_CONFIG.BSSID + 6)] : null;
    // The scan threshold: an AP weaker or less secure than it isn't a candidate (Arduino sets
    // WPA2 whenever a password is given, so an open AP isn't joined with one).
    const minRssi = (config[T.STA_CONFIG.THRESHOLD] << 24) >> 24;
    const minAuth = config[T.STA_CONFIG.THRESHOLD + 4];
    const ap = this.accessPoints()
      .filter((a) => a.ssid === ssid && (channel === 0 || a.channel === channel) && (bssid === null || a.bssid.every((b, i) => b === bssid[i])) && a.rssi >= minRssi && strength(a.auth) >= strength(minAuth))
      .sort((a, b) => b.rssi - a.rssi)[0];
    // Finding the AP takes the connect scan: every channel at the active default dwell.
    const scanMs = channel === 0 ? CHANNELS * ACTIVE_DEFAULT_MS : ACTIVE_DEFAULT_MS;
    this.connecting = true;
    this.associated = null;
    this.unlink();
    const stopConnecting = (): boolean => {
      this.connecting = false;
      return true;
    };
    if (ap === undefined) {
      this.schedule(scanMs, T.WIFI_EVENT.STA_DISCONNECTED, this.disconnectedData(ssid, null, T.WIFI_REASON.NO_AP_FOUND), stopConnecting);
      return T.ESP_OK;
    }
    if (ap.auth !== T.WIFI_AUTH.OPEN && ap.password !== password) {
      // WPA2 with the wrong key: the 4-way handshake never completes (IDF 4.4's reason 15).
      this.schedule(scanMs + HANDSHAKE_FAIL_MS, T.WIFI_EVENT.STA_DISCONNECTED, this.disconnectedData(ssid, ap, 15), stopConnecting);
      return T.ESP_OK;
    }
    const data = new Uint8Array(T.STA_CONNECTED.SIZE);
    const name = utf8(ap.ssid).slice(0, 32);
    data.set(name, T.STA_CONNECTED.SSID);
    data[T.STA_CONNECTED.SSID_LEN] = name.length;
    data.set(ap.bssid.slice(0, 6), T.STA_CONNECTED.BSSID);
    data[T.STA_CONNECTED.CHANNEL] = ap.channel;
    data[T.STA_CONNECTED.AUTHMODE] = ap.auth;
    this.schedule(scanMs + ASSOCIATE_MS, T.WIFI_EVENT.STA_CONNECTED, data, () => {
      this.connecting = false;
      if (!this.linkTo(ap)) {
        // Gone while the station looked for it.
        this.schedule(0, T.WIFI_EVENT.STA_DISCONNECTED, this.disconnectedData(ssid, null, T.WIFI_REASON.NO_AP_FOUND));
        return false;
      }
      this.associated = ap;
      return true;
    });
    return T.ESP_OK;
  }

  /** The radio's access points with IDF's auth modes. */
  private accessPoints(): VirtualAp[] {
    return (this.host.radio()?.accessPoints() ?? []).map((ap) => ({ ...ap, auth: AUTH_OF[ap.security] }));
  }

  private disconnect(call: WifiCall): number | HleTask {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    if (!this.started) return T.ESP_ERR_WIFI_NOT_STARTED;
    const was = this.associated;
    const wasConnecting = this.connecting;
    this.dropStation();
    if (was === null && !wasConnecting) return T.ESP_OK;
    const ssid = cString(this.staConfig, T.STA_CONFIG.SSID, 32);
    return this.postNow(call, T.WIFI_EVENT.STA_DISCONNECTED, this.disconnectedData(ssid, was, T.WIFI_REASON.ASSOC_LEAVE));
  }

  private *postNow(call: WifiCall, id: number, data: Uint8Array): HleTask {
    yield* this.post(call, id, data);
    return T.ESP_OK;
  }

  private disconnectedData(ssid: string, ap: VirtualAp | null, reason: number): Uint8Array {
    const data = new Uint8Array(T.STA_DISCONNECTED.SIZE);
    const name = utf8(ssid).slice(0, 32);
    data.set(name, T.STA_DISCONNECTED.SSID);
    data[T.STA_DISCONNECTED.SSID_LEN] = name.length;
    if (ap !== null) data.set(ap.bssid.slice(0, 6), T.STA_DISCONNECTED.BSSID);
    data[T.STA_DISCONNECTED.REASON] = reason;
    data[T.STA_DISCONNECTED.RSSI] = (ap?.rssi ?? 0) & 0xff;
    return data;
  }

  private apInfo(call: WifiCall): number {
    if (!this.inited) return T.ESP_ERR_WIFI_NOT_INIT;
    const ap = this.associated;
    if (ap === null) return T.ESP_ERR_WIFI_NOT_CONNECT;
    if (call.arg(0) === 0) return T.ESP_ERR_INVALID_ARG;
    this.writeRecord(call, call.arg(0), ap);
    return T.ESP_OK;
  }

  // ── Frames ────────────────────────────────────────────────────────────────────────────

  private regRx(call: WifiCall): number {
    const ifx = call.arg(0);
    if (ifx > 1) return T.ESP_ERR_WIFI_IF;
    this.rxCallbacks[ifx] = call.arg(1);
    return T.ESP_OK;
  }

  /** esp_wifi_internal_tx(ifx, buffer, len) and _by_ref(…, netstack_buf): the frame is copied now (BT116: on the soft-AP's LAN for WIFI_IF_AP). */
  private transmit(call: WifiCall): number {
    const ifx = call.arg(0);
    const length = call.arg(2) & 0xffff;
    if (ifx === T.WIFI_IF.AP) {
      if (this.softAp === null) return T.ESP_ERR_WIFI_NOT_STARTED;
      if (length < 14 || length > 1600) return T.ESP_ERR_INVALID_ARG;
      this.framesOut++;
      this.softAp.send(call.readBytes(call.arg(1), length));
      return T.ESP_OK;
    }
    if (ifx !== T.WIFI_IF.STA || this.link === null) return T.ESP_ERR_WIFI_NOT_ASSOC;
    if (length < 14 || length > 1600) return T.ESP_ERR_INVALID_ARG;
    this.framesOut++;
    this.link.send(call.readBytes(call.arg(1), length));
    return T.ESP_OK;
  }

  /** esp_wifi_internal_free_rx_buffer(eb): a buffer the WiFi task allocated for lwIP. */
  private *freeRx(call: WifiCall): HleTask {
    const buffer = call.arg(0);
    if (buffer !== 0) yield call.call(this.address('free'), buffer);
    return T.ESP_OK;
  }
}
