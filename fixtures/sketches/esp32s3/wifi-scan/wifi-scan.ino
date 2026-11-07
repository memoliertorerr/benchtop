// wifi-scan (ESP32-S3, BT127: the ESP32's sketch as is) — tests assert (BT97): WiFi.mode(WIFI_STA) then WiFi.scanNetworks() lists the bench's
// virtual access points, one line each "<ssid> <rssi> <encryption>", then "scan done <n>"; then
// WiFi.begin("benchtop", "simulated") connects: "connected <ip>" once WiFi.status() is
// WL_CONNECTED.
#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  int n = WiFi.scanNetworks();
  for (int i = 0; i < n; i++) Serial.printf("%s %d %d\n", WiFi.SSID(i).c_str(), (int)WiFi.RSSI(i), (int)WiFi.encryptionType(i));
  Serial.printf("scan done %d\n", n);
  WiFi.begin("benchtop", "simulated");
  while (WiFi.status() != WL_CONNECTED) delay(50);
  Serial.printf("connected %s\n", WiFi.localIP().toString().c_str());
}

void loop() {
  delay(1000);
}
