import { type LanClock, macString, NetRuntime, type WifiLink } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import type { HleTask, Upcall } from '../hle/hle.ts';
import { type WifiCall, WifiDriver, WIFI_NEEDS } from './driver.ts';
import * as T from './types.ts';

// BT116: the soft-AP side of the driver, called as the firmware would — each handler through a
// fake call over a flat memory, generators stepped with the firmware's answers — on the real
// network runtime (NetRuntime's radio), where other "boards" join it. The firmware's own use of it
// is packages/parts/src/integration/softap.test.ts.

const REF_HZ = 1_000_000;
const MEM = 0x10000;
const SCRATCH = 0x8000;
const CONFIG = 0x9000;
const OUT = 0x9800;
const WIFI_EVENT_BASE = 0x100;
const AP_MAC = [0x24, 0x0a, 0xc4, 0x12, 0x34, 0x57];

class FakeCall implements WifiCall {
  readonly scratch = SCRATCH;
  readonly mem: Uint8Array;
  readonly args: number[];
  constructor(mem: Uint8Array, args: number[]) {
    this.mem = mem;
    this.args = args;
  }
  arg(i: number): number {
    return (this.args[i] ?? 0) >>> 0;
  }
  int(i: number): number {
    return (this.args[i] ?? 0) | 0;
  }
  call(fn: number, ...args: number[]): Upcall {
    return { fn, args };
  }
  read8(a: number): number {
    return this.mem[a];
  }
  read16(a: number): number {
    return this.mem[a] | (this.mem[a + 1] << 8);
  }
  read32(a: number): number {
    return (this.read16(a) | (this.read16(a + 2) << 16)) >>> 0;
  }
  write8(a: number, v: number): void {
    this.mem[a] = v & 0xff;
  }
  write16(a: number, v: number): void {
    this.write8(a, v);
    this.write8(a + 1, v >>> 8);
  }
  write32(a: number, v: number): void {
    this.write16(a, v);
    this.write16(a + 2, v >>> 16);
  }
  readBytes(a: number, n: number): Uint8Array {
    return this.mem.slice(a, a + n);
  }
  writeBytes(a: number, bytes: ArrayLike<number>): void {
    this.mem.set(Array.from(bytes), a);
  }
  fill(a: number, n: number, v = 0): void {
    this.mem.fill(v, a, a + n);
  }
}

function testClock(): LanClock & { time: number } {
  const clock = { time: 0, now: () => clock.time, schedule: () => {} };
  return clock;
}

/** A driver installed on fake firmware, its radio the runtime's radio for board "esp". */
function rig() {
  const clock = testClock();
  const net = NetRuntime.build([], () => undefined, clock);
  const mem = new Uint8Array(MEM);
  const handlers = new Map<string, (call: WifiCall) => number | HleTask>();
  const addresses = new Map<string, number>();
  const address = (name: string): number => {
    let at = addresses.get(name);
    if (at === undefined) addresses.set(name, (at = 0x1000 + addresses.size * 4));
    return at;
  };
  for (const name of WIFI_NEEDS) address(name);
  new FakeCall(mem, []).write32(address('WIFI_EVENT'), WIFI_EVENT_BASE);
  const driver = new WifiDriver({ now: () => clock.time, refHz: REF_HZ, mac: [0x24, 0x0a, 0xc4, 0x12, 0x34, 0x56], radio: () => net.radioFor('esp') });
  driver.install({ replace: (_at, name, handler) => handlers.set(name, handler) }, (name) => address(name));
  const posted: { id: number; data: number[] }[] = [];
  /** Runs `fn`'s handler to its end, answering its calls into the firmware. */
  const run = (task: number | HleTask): number => {
    if (typeof task === 'number') return task;
    for (let step = task.next(0); ; ) {
      if (step.done === true) return step.value;
      const { fn, args } = step.value;
      if (fn === address('esp_event_post')) posted.push({ id: args[1], data: [...mem.slice(args[2], args[2] + args[3])] });
      step = task.next(fn === address('xTaskCreatePinnedToCore') ? 1 : 0);
    }
  };
  const invoke = (name: string, ...args: number[]): number => {
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error(`no handler ${name}`);
    return run(handler(new FakeCall(mem, args)));
  };
  /** One pass of the WiFi task: posts what is due (it ends at its sleep). */
  const task = (handlers.get('wifi task') as ((call: WifiCall) => HleTask) | undefined)?.(new FakeCall(mem, []));
  const pump = (): void => {
    if (task === undefined) return;
    for (let step = task.next(0); !step.done; step = task.next(0)) {
      const { fn, args } = step.value;
      if (fn === address('esp_event_post')) posted.push({ id: args[1], data: [...mem.slice(args[2], args[2] + args[3])] });
      if (fn === address('vTaskDelay')) return;
    }
  };
  /** esp_wifi_set_config(WIFI_IF_AP) with an SSID, password and auth mode. */
  const setAp = (ssid: string, password: string, auth: number, max = 4): number => {
    const call = new FakeCall(mem, []);
    call.fill(CONFIG, T.AP_CONFIG.SIZE);
    call.writeBytes(CONFIG + T.AP_CONFIG.SSID, [...ssid].map((c) => c.charCodeAt(0)));
    call.write8(CONFIG + T.AP_CONFIG.SSID_LEN, ssid.length);
    call.writeBytes(CONFIG + T.AP_CONFIG.PASSWORD, [...password].map((c) => c.charCodeAt(0)));
    call.write8(CONFIG + T.AP_CONFIG.CHANNEL, 6);
    call.write32(CONFIG + T.AP_CONFIG.AUTHMODE, auth);
    call.write8(CONFIG + T.AP_CONFIG.MAX_CONNECTION, max);
    return invoke('esp_wifi_set_config', T.WIFI_IF.AP, CONFIG);
  };
  /** Another board's station joining the soft-AP. */
  const station = (mac: number[]): { link: WifiLink | undefined; lost: () => number } => {
    let lost = 0;
    const link = net.radioFor(`board-${mac[5]}`).join(AP_MAC, mac, () => {}, () => lost++);
    return { link, lost: () => lost };
  };
  const events = (id: number): number[][] => posted.filter((p) => p.id === id).map((p) => p.data);
  return { net, mem, driver, invoke, pump, setAp, station, posted, events };
}

const A = [2, 0, 0, 0, 0, 0xa];
const B = [2, 0, 0, 0, 0, 0xb];
const apEvent = (mac: number[], aid: number): number[] => [...mac, aid, 0];

describe('the ESP32 WiFi driver’s soft-AP (BT116)', () => {
  it('starts in AP mode with IDF’s default configuration, then hosts the one set; stations join with the lowest free AID', () => {
    const r = rig();
    expect(r.invoke('esp_wifi_init', 0)).toBe(T.ESP_OK);
    expect(r.invoke('esp_wifi_set_mode', T.WIFI_MODE.AP)).toBe(T.ESP_OK);
    expect(r.invoke('esp_wifi_start')).toBe(T.ESP_OK);
    expect(r.events(T.WIFI_EVENT.AP_START)).toHaveLength(1);
    expect(r.net.softAccessPoints[0].config).toEqual({ ssid: 'ESP_123457', password: '', security: 'open', channel: 1, hidden: false, maxStations: 4 });
    expect(r.setAp('benchtop-ap', 'simulated1', T.WIFI_AUTH.WPA2_PSK, 2)).toBe(T.ESP_OK);
    expect(r.net.softAccessPoints.map((s) => s.config)).toEqual([{ ssid: 'benchtop-ap', password: 'simulated1', security: 'wpa2', channel: 6, hidden: false, maxStations: 2 }]);
    expect(r.net.radioFor('other').accessPoints().map((ap) => macString(ap.bssid))).toEqual(['24:0a:c4:12:34:57']);
    const a = r.station(A);
    const b = r.station(B);
    expect(r.station([2, 0, 0, 0, 0, 0xc]).link).toBeUndefined(); // two at most
    r.pump();
    expect(r.events(T.WIFI_EVENT.AP_STACONNECTED)).toEqual([apEvent(A, 1), apEvent(B, 2)]);
    a.link?.leave();
    r.pump();
    expect(r.events(T.WIFI_EVENT.AP_STADISCONNECTED)).toEqual([apEvent(A, 1)]);
    const c = r.station([2, 0, 0, 0, 0, 0xc]);
    r.pump();
    expect(r.events(T.WIFI_EVENT.AP_STACONNECTED).at(-1)).toEqual(apEvent([2, 0, 0, 0, 0, 0xc], 1)); // AID 1 is free again
    expect(b.lost() + c.lost()).toBe(0);
  });

  it('esp_wifi_ap_get_sta_list, esp_wifi_ap_get_sta_aid and esp_wifi_deauth_sta', () => {
    const r = rig();
    r.invoke('esp_wifi_init', 0);
    r.invoke('esp_wifi_set_mode', T.WIFI_MODE.APSTA);
    r.invoke('esp_wifi_start');
    r.setAp('benchtop-ap', '', T.WIFI_AUTH.OPEN);
    const a = r.station(A);
    const b = r.station(B);
    r.pump();
    expect(r.invoke('esp_wifi_ap_get_sta_list', OUT)).toBe(T.ESP_OK);
    const call = new FakeCall(r.mem, []);
    expect(call.read32(OUT + T.STA_LIST.NUM)).toBe(2);
    expect([...call.readBytes(OUT + T.STA_INFO.SIZE + T.STA_INFO.MAC, 6)]).toEqual(B);
    expect((call.read8(OUT + T.STA_INFO.RSSI) << 24) >> 24).toBe(-45);
    expect(call.read32(OUT + T.STA_INFO.FLAGS)).toBe(0b111);
    call.writeBytes(CONFIG, B);
    expect(r.invoke('esp_wifi_ap_get_sta_aid', CONFIG, OUT)).toBe(T.ESP_OK);
    expect(call.read16(OUT)).toBe(2);
    call.writeBytes(CONFIG, [2, 0, 0, 0, 0, 0xee]);
    expect(r.invoke('esp_wifi_ap_get_sta_aid', CONFIG, OUT)).toBe(T.ESP_ERR_NOT_FOUND);
    // Turned away: the station loses its AP, the firmware hears AP_STADISCONNECTED.
    expect(r.invoke('esp_wifi_deauth_sta', 2)).toBe(T.ESP_OK);
    r.pump();
    expect(b.lost()).toBe(1);
    expect(r.events(T.WIFI_EVENT.AP_STADISCONNECTED)).toEqual([apEvent(B, 2)]);
    expect(r.invoke('esp_wifi_deauth_sta', 0)).toBe(T.ESP_OK); // every one
    r.pump();
    expect(a.lost()).toBe(1);
    expect(r.driver.apStations).toEqual([]);
  });

  it('a new AP configuration while it runs drops its stations (each told off); an empty SSID hosts nothing', () => {
    const r = rig();
    r.invoke('esp_wifi_init', 0);
    r.invoke('esp_wifi_set_mode', T.WIFI_MODE.AP);
    r.invoke('esp_wifi_start');
    r.setAp('first', '', T.WIFI_AUTH.OPEN);
    const a = r.station(A);
    r.pump();
    r.setAp('second', '', T.WIFI_AUTH.OPEN);
    r.pump();
    expect(a.lost()).toBe(1);
    expect(r.events(T.WIFI_EVENT.AP_STADISCONNECTED)).toEqual([apEvent(A, 1)]);
    expect(r.net.softAccessPoints.map((s) => s.config.ssid)).toEqual(['second']);
    r.setAp('', '', T.WIFI_AUTH.OPEN); // WiFi.softAPdisconnect()
    expect(r.net.softAccessPoints).toEqual([]);
  });

  it('leaving AP mode (or stopping) tells each station off before AP_STOP; frames on WIFI_IF_AP need the AP up', () => {
    const r = rig();
    r.invoke('esp_wifi_init', 0);
    r.invoke('esp_wifi_set_mode', T.WIFI_MODE.AP);
    r.invoke('esp_wifi_start');
    r.setAp('benchtop-ap', '', T.WIFI_AUTH.OPEN);
    const a = r.station(A);
    r.pump();
    const frame = new FakeCall(r.mem, []);
    frame.fill(OUT, 60, 0xff);
    expect(r.invoke('esp_wifi_internal_tx', T.WIFI_IF.AP, OUT, 60)).toBe(T.ESP_OK);
    expect(r.driver.framesOut).toBe(1);
    const before = r.posted.length;
    expect(r.invoke('esp_wifi_set_mode', T.WIFI_MODE.STA)).toBe(T.ESP_OK);
    expect(r.posted.slice(before).map((p) => p.id)).toEqual([T.WIFI_EVENT.AP_STADISCONNECTED, T.WIFI_EVENT.AP_STOP, T.WIFI_EVENT.STA_START]); // the station comes up
    expect(a.lost()).toBe(1);
    expect(r.net.softAccessPoints).toEqual([]);
    expect(r.invoke('esp_wifi_internal_tx', T.WIFI_IF.AP, OUT, 60)).toBe(T.ESP_ERR_WIFI_NOT_STARTED);
  });

  it('the bench closing the AP (a reset) leaves the driver without it; a new radio gets it hosted again', () => {
    const r = rig();
    r.invoke('esp_wifi_init', 0);
    r.invoke('esp_wifi_set_mode', T.WIFI_MODE.AP);
    r.invoke('esp_wifi_start');
    r.setAp('benchtop-ap', '', T.WIFI_AUTH.OPEN);
    r.station(A);
    r.pump();
    r.net.reset();
    expect(r.driver.apStations).toEqual([]);
    expect(r.net.softAccessPoints).toEqual([]);
    r.driver.radioChanged();
    expect(r.net.softAccessPoints.map((s) => s.config.ssid)).toEqual(['benchtop-ap']);
    // A reset of the board itself: the driver is disposed, its AP gone.
    r.driver.dispose();
    expect(r.net.softAccessPoints).toEqual([]);
  });
});
