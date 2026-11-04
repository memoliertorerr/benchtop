/**
 * The ESP32 WiFi API's types as Arduino-ESP32 2.0.17 (ESP-IDF 4.4) compiles them (BT97):
 * offsets and sizes measured with the toolchain (offsetof/sizeof in a file built with the
 * sketch's own flags), event ids, error codes and disconnect reasons from esp_wifi_types.h and
 * esp_err.h. Little-endian, 32-bit enums.
 */

export const ESP_OK = 0;
export const ESP_ERR_NO_MEM = 0x101;
export const ESP_ERR_INVALID_ARG = 0x102;
export const ESP_ERR_NOT_FOUND = 0x105;
export const ESP_ERR_NOT_SUPPORTED = 0x106;
export const ESP_ERR_WIFI_NOT_INIT = 0x3001;
export const ESP_ERR_WIFI_NOT_STARTED = 0x3002;
export const ESP_ERR_WIFI_NOT_STOPPED = 0x3003;
export const ESP_ERR_WIFI_IF = 0x3004;
export const ESP_ERR_WIFI_MODE = 0x3005;
export const ESP_ERR_WIFI_STATE = 0x3006;
export const ESP_ERR_WIFI_CONN = 0x3007;
export const ESP_ERR_WIFI_NOT_CONNECT = 0x300f;
export const ESP_ERR_WIFI_NOT_ASSOC = 0x3015;

/** portMAX_DELAY. */
export const PORT_MAX_DELAY = 0xffffffff;
/** FreeRTOS ticks per second in Arduino-ESP32 (configTICK_RATE_HZ). */
export const TICK_HZ = 1000;

export const WIFI_MODE = { NULL: 0, STA: 1, AP: 2, APSTA: 3 } as const;
export const WIFI_IF = { STA: 0, AP: 1 } as const;

/** wifi_event_t. */
export const WIFI_EVENT = { READY: 0, SCAN_DONE: 1, STA_START: 2, STA_STOP: 3, STA_CONNECTED: 4, STA_DISCONNECTED: 5, AP_START: 12, AP_STOP: 13, AP_STACONNECTED: 14, AP_STADISCONNECTED: 15 } as const;

/** wifi_err_reason_t values the station reports. */
export const WIFI_REASON = { AUTH_LEAVE: 3, ASSOC_LEAVE: 8, BEACON_TIMEOUT: 200, NO_AP_FOUND: 201, AUTH_FAIL: 202, HANDSHAKE_TIMEOUT: 204, CONNECTION_FAIL: 205 } as const;

/** wifi_auth_mode_t. */
export const WIFI_AUTH = { OPEN: 0, WEP: 1, WPA_PSK: 2, WPA2_PSK: 3, WPA_WPA2_PSK: 4, WPA2_ENTERPRISE: 5, WPA3_PSK: 6, WPA2_WPA3_PSK: 7 } as const;

/** wifi_ap_record_t (80 bytes). */
export const AP_RECORD = { SIZE: 80, BSSID: 0, SSID: 6, PRIMARY: 39, SECOND: 40, RSSI: 44, AUTHMODE: 48, PAIRWISE: 52, GROUP: 56, ANT: 60, PHY: 64, COUNTRY: 68 } as const;

/** wifi_sta_config_t (140 bytes; wifi_config_t is the union of it and wifi_ap_config_t). */
export const STA_CONFIG = { SIZE: 140, SSID: 0, PASSWORD: 32, SCAN_METHOD: 96, BSSID_SET: 100, BSSID: 101, CHANNEL: 107, LISTEN_INTERVAL: 108, SORT_METHOD: 112, THRESHOLD: 116 } as const;

/** wifi_ap_config_t (116 bytes). */
export const AP_CONFIG = { SIZE: 116, SSID: 0, PASSWORD: 32, SSID_LEN: 96, CHANNEL: 97, AUTHMODE: 100, SSID_HIDDEN: 104, MAX_CONNECTION: 105, BEACON_INTERVAL: 106 } as const;

/** wifi_scan_config_t (32 bytes): scan_time is { active: { min, max }, passive }. */
export const SCAN_CONFIG = { SIZE: 32, SSID: 0, BSSID: 4, CHANNEL: 8, SHOW_HIDDEN: 9, SCAN_TYPE: 12, ACTIVE_MIN: 16, ACTIVE_MAX: 20, PASSIVE: 24 } as const;

/** wifi_event_sta_scan_done_t (8 bytes). */
export const SCAN_DONE = { SIZE: 8, STATUS: 0, NUMBER: 4, SCAN_ID: 5 } as const;

/** wifi_event_sta_connected_t (44 bytes). */
export const STA_CONNECTED = { SIZE: 44, SSID: 0, SSID_LEN: 32, BSSID: 33, CHANNEL: 39, AUTHMODE: 40 } as const;

/** wifi_event_sta_disconnected_t (41 bytes). */
export const STA_DISCONNECTED = { SIZE: 41, SSID: 0, SSID_LEN: 32, BSSID: 33, REASON: 39, RSSI: 40 } as const;

/** wifi_country_t (12 bytes): cc[3], schan, nchan, max_tx_power, policy (u32 at 8). */
export const COUNTRY = { SIZE: 12, CC: 0, SCHAN: 3, NCHAN: 4, MAX_TX_POWER: 5, POLICY: 8 } as const;

/** BT116: wifi_event_ap_staconnected_t and wifi_event_ap_stadisconnected_t (8 bytes each: mac, aid, is_mesh_child; wifi-softap's layout line). */
export const AP_STA_EVENT = { SIZE: 8, MAC: 0, AID: 6, MESH_CHILD: 7 } as const;

/** BT116: wifi_sta_info_t (12 bytes): mac, rssi, then phy_11b/g/n, phy_lr and is_mesh_child as bits 0–4 of a u32. */
export const STA_INFO = { SIZE: 12, MAC: 0, RSSI: 6, FLAGS: 8 } as const;

/** wifi_sta_list_t (184 bytes): 15 wifi_sta_info_t of 12 bytes, then num. */
export const STA_LIST = { SIZE: 184, NUM: 180 } as const;
/** BT107: the ESP32-C3's (124 bytes): ESP_WIFI_MAX_CONN_NUM is 10 there. Every other layout above is the C3's too (wifi-layout). */
export const STA_LIST_C3 = { SIZE: 124, NUM: 120 } as const;
