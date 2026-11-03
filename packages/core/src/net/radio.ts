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

export interface WifiRadio {
  /** The access points on now. */
  accessPoints(): readonly AccessPointInfo[];
  /**
   * Joins the LAN of the access point `bssid` (it must be on) as `mac`: frames for `mac` and
   * broadcasts arrive through `receive` at the bench time they land; `lost` runs if the access
   * point goes off (or away in a rebuild). Undefined when there is no such access point.
   */
  join(bssid: Mac, mac: Mac, receive: (frame: Uint8Array) => void, lost: () => void): WifiLink | undefined;
}

/** An MCU with WiFi: the bench hands it its radio (null: none) whenever it builds. */
export interface WifiStation {
  joinWifi(radio: WifiRadio | null): void;
}

export function usesWifi(mcu: object): mcu is WifiStation {
  return typeof (mcu as Partial<WifiStation>).joinWifi === 'function';
}
