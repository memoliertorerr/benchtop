// wifi-layout (Pico W) — tests assert (BT111): the cyw43-driver's event and scan structs as the
// Pico W's toolchain lays them out, printed as "name size offset…" lines on Serial (USB), so a
// test holds them to the table the simulated CYW43 writes (packages/rp2040/src/cyw43/), then
// "layout done".
#include <pico/cyw43_arch.h>
#include <stddef.h>

#define F(type, field) (int)offsetof(type, field)

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.printf("async_event %d %d %d %d %d %d %d\n", (int)sizeof(cyw43_async_event_t), F(cyw43_async_event_t, flags), F(cyw43_async_event_t, event_type),
                F(cyw43_async_event_t, status), F(cyw43_async_event_t, reason), F(cyw43_async_event_t, interface), F(cyw43_async_event_t, u));
  Serial.printf("scan_result %d %d %d %d %d %d %d\n", (int)sizeof(cyw43_ev_scan_result_t), F(cyw43_ev_scan_result_t, bssid), F(cyw43_ev_scan_result_t, ssid_len),
                F(cyw43_ev_scan_result_t, ssid), F(cyw43_ev_scan_result_t, channel), F(cyw43_ev_scan_result_t, auth_mode), F(cyw43_ev_scan_result_t, rssi));
  Serial.printf("scan_options %d %d %d\n", (int)sizeof(cyw43_wifi_scan_options_t), F(cyw43_wifi_scan_options_t, ssid_len), F(cyw43_wifi_scan_options_t, ssid));
  Serial.println("layout done");
}

void loop() {
  delay(1000);
}
