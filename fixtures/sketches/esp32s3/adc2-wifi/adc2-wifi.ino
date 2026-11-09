// adc2-wifi (ESP32-S3) — tests assert (BT163): the ESP32's ADC2-and-WiFi sketch on the S3, on GPIO11
// (ADC2 channel 0; 12 bits, 11 dB): "before <v>", WiFi.mode(WIFI_STA), "with wifi <v>",
// WiFi.mode(WIFI_OFF), "after <v>". On the S3, ESP-IDF 4.4's ADC2 lock is a no-op (a hardware arbiter
// decides per conversion, with WiFi's power detection, which the bench doesn't simulate), so all three
// reads give the pin's code here — unlike the ESP32, where the read with WiFi returns 0.
#include <WiFi.h>

const int PIN = 11;

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
