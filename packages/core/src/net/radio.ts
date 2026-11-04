/**
 * What a board's WiFi sees of the bench (BT98): the access points on, and a link into one's LAN.
 * Not part of the frozen contracts — an MCU that has WiFi says so with `joinWifi` (the ESP32's
 * driver at its API, @benchtop/esp32's wifi/), as one that uses symbols does with `useSymbols`.
 */

import type { Mac } from './packet.ts';

export type WifiSecurity = 'open' | 'wep' | 'wpa' | 'wpa2' | 'wpa-wpa2' | 'wpa3' | 'wpa2-wpa3';

export const WIFI_SECURITIES: readonly WifiSecurity[] = ['open', 'wep', 'wpa', 'wpa2', 'wpa-wpa2', 'wpa3', 'wpa2-wpa3'];

export interface AccessPointInfo {
  readonly ssid: string;
  readonly bssid: Mac;
  /** 1–13. */
  readonly channel: number;
  /** dBm, as the station hears it. */
  readonly rssi: number;
  readonly security: WifiSecurity;
  /** The key a station must present ('' when open). */
  readonly password: string;
  /** Not in beacons: found only by a scan for its SSID (or one showing hidden networks). */
  readonly hidden: boolean;
}

/** A station's association with an access point: its port on that AP's LAN. */
export interface WifiLink {
  /** An Ethernet II frame from the station, at the bench's now (the sending MCU's time). */
  send(frame: Uint8Array): void;
  /** Leaves the LAN (frames still in the air for the station are dropped). */
  leave(): void;
}

/** BT115: an access point a board hosts (its soft-AP): what other stations' scans see. */
export interface SoftApConfig {
  readonly ssid: string;
  readonly password: string;
  readonly security: WifiSecurity;
  /** 1–13. */
  readonly channel: number;
  readonly hidden: boolean;
  /** Stations it takes at most (more are turned away). */
  readonly maxStations: number;
}

/** BT115: what the hosting board hears of its soft-AP. */
export interface SoftApEvents {
  /** A frame for the board's AP interface, at the bench time it arrives. */
  receive(frame: Uint8Array): void;
  /** A station associated (its MAC). */
  joined(mac: Mac): void;
  /** A station left, or was dropped. */
  left(mac: Mac): void;
  /**
   * BT116: the bench closed the AP itself (a reset, or a rebuild without this board) — not when the
   * board's own `close()` did. Its stations are gone, without a `left` each.
   */
  closed?(): void;
}

/** BT115: the board's side of its soft-AP. */
export interface SoftApLink {
  /** An Ethernet II frame from the board's AP interface onto its LAN. */
  send(frame: Uint8Array): void;
  /** The stations on it now. */
  stations(): Mac[];
  /** BT116: turns a station away (a deauthentication): `left` follows; false when it isn't on. */
  drop(mac: Mac): boolean;
  /** The AP is gone (its stations are dropped). */
  close(): void;
}

export interface WifiRadio {
  /** The access points on now (BT115: other boards' soft-APs too, not the asking board's own). */
  accessPoints(): readonly AccessPointInfo[];
  /**
   * Joins the LAN of the access point `bssid` (it must be on) as `mac`: frames for `mac` and
   * broadcasts arrive through `receive` at the bench time they land; `lost` runs if the access
   * point goes off (or away in a rebuild). Undefined when there is no such access point.
   */
  join(bssid: Mac, mac: Mac, receive: (frame: Uint8Array) => void, lost: () => void): WifiLink | undefined;
  /**
   * BT115: hosts an access point on the bench as `bssid` (the board's AP MAC): other boards' scans
   * list it and their stations join its LAN, the board's AP interface the LAN's other end. One a
   * board: hosting again replaces the old one. Optional — a radio without soft-APs (a test's) lacks it.
   */
  hostAp?(config: SoftApConfig, bssid: Mac, events: SoftApEvents): SoftApLink | undefined;
}

/** An MCU with WiFi: the bench hands it its radio (null: none) whenever it builds. */
export interface WifiStation {
  joinWifi(radio: WifiRadio | null): void;
}

export function usesWifi(mcu: object): mcu is WifiStation {
  return typeof (mcu as Partial<WifiStation>).joinWifi === 'function';
}
