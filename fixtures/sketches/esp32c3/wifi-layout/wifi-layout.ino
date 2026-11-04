// wifi-layout — tests assert (BT107): the WiFi API's struct layouts as the ESP32-C3's toolchain
// builds them, printed as "name size offset…" lines, so a test holds them to the table the
// simulated WiFi driver uses (packages/esp32/src/wifi/types.ts, measured on the ESP32 in BT97).
#include <esp_wifi.h>
#include <stddef.h>

#define F(type, field) (int)offsetof(type, field)

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.printf("ap_record %d %d %d %d %d %d %d %d %d %d %d %d\n", (int)sizeof(wifi_ap_record_t), F(wifi_ap_record_t, bssid), F(wifi_ap_record_t, ssid),
                F(wifi_ap_record_t, primary), F(wifi_ap_record_t, second), F(wifi_ap_record_t, rssi), F(wifi_ap_record_t, authmode),
                F(wifi_ap_record_t, pairwise_cipher), F(wifi_ap_record_t, group_cipher), F(wifi_ap_record_t, ant), (int)offsetof(wifi_ap_record_t, ant) + 4,
                F(wifi_ap_record_t, country));
  Serial.printf("sta_config %d %d %d %d %d %d %d %d %d %d\n", (int)sizeof(wifi_sta_config_t), F(wifi_sta_config_t, ssid), F(wifi_sta_config_t, password),
                F(wifi_sta_config_t, scan_method), F(wifi_sta_config_t, bssid_set), F(wifi_sta_config_t, bssid), F(wifi_sta_config_t, channel),
                F(wifi_sta_config_t, listen_interval), F(wifi_sta_config_t, sort_method), F(wifi_sta_config_t, threshold));
  Serial.printf("ap_config %d %d %d %d %d %d %d %d\n", (int)sizeof(wifi_ap_config_t), F(wifi_ap_config_t, ssid), F(wifi_ap_config_t, password),
                F(wifi_ap_config_t, ssid_len), F(wifi_ap_config_t, channel), F(wifi_ap_config_t, authmode), F(wifi_ap_config_t, ssid_hidden),
                F(wifi_ap_config_t, max_connection));
  Serial.printf("scan_config %d %d %d %d %d %d %d %d %d\n", (int)sizeof(wifi_scan_config_t), F(wifi_scan_config_t, ssid), F(wifi_scan_config_t, bssid),
                F(wifi_scan_config_t, channel), F(wifi_scan_config_t, show_hidden), F(wifi_scan_config_t, scan_type), F(wifi_scan_config_t, scan_time.active.min),
                F(wifi_scan_config_t, scan_time.active.max), F(wifi_scan_config_t, scan_time.passive));
  Serial.printf("scan_done %d %d %d %d\n", (int)sizeof(wifi_event_sta_scan_done_t), F(wifi_event_sta_scan_done_t, status), F(wifi_event_sta_scan_done_t, number),
                F(wifi_event_sta_scan_done_t, scan_id));
  Serial.printf("sta_connected %d %d %d %d %d %d\n", (int)sizeof(wifi_event_sta_connected_t), F(wifi_event_sta_connected_t, ssid), F(wifi_event_sta_connected_t, ssid_len),
                F(wifi_event_sta_connected_t, bssid), F(wifi_event_sta_connected_t, channel), F(wifi_event_sta_connected_t, authmode));
  Serial.printf("sta_disconnected %d %d %d %d %d %d\n", (int)sizeof(wifi_event_sta_disconnected_t), F(wifi_event_sta_disconnected_t, ssid),
                F(wifi_event_sta_disconnected_t, ssid_len), F(wifi_event_sta_disconnected_t, bssid), F(wifi_event_sta_disconnected_t, reason),
                F(wifi_event_sta_disconnected_t, rssi));
  Serial.printf("country %d %d %d %d %d %d\n", (int)sizeof(wifi_country_t), F(wifi_country_t, cc), F(wifi_country_t, schan), F(wifi_country_t, nchan),
                F(wifi_country_t, max_tx_power), F(wifi_country_t, policy));
  Serial.printf("sta_list %d %d\n", (int)sizeof(wifi_sta_list_t), F(wifi_sta_list_t, num));
  Serial.println("layout done");
}

void loop() {
  delay(1000);
}
