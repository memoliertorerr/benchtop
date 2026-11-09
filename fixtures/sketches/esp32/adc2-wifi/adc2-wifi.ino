// adc2-wifi (ESP32) — tests assert (BT163): ADC2 and WiFi, as on a board. analogRead on GPIO4, ADC2 channel 0
// (12 bits, 11 dB) prints "before <v>"; WiFi.mode(WIFI_STA) starts WiFi, which takes ESP-IDF's ADC2
// lock, so the next read fails ("ADC2 is in use by Wi-Fi" in the core's log) and returns 0: "with
// wifi <v>"; WiFi.mode(WIFI_OFF) stops WiFi and gives the lock back: "after <v>".
#include <WiFi.h>

const int PIN = 4;

void setup() {
  Serial.begin(115200);
  delay(100);
  analogReadResolution(12);
  Serial.printf("before %d\n", analogRead(PIN));
  WiFi.mode(WIFI_STA);
  delay(200);
  Serial.printf("with wifi %d\n", analogRead(PIN));
  WiFi.mode(WIFI_OFF);
  delay(200);
  Serial.printf("after %d\n", analogRead(PIN));
}

void loop() {
  delay(1000);
}
