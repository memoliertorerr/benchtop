// adc2-read (ESP32) — tests assert (BT162): every 20 ms a line "adc2 <ten readings> z=<GPIO4 at
// 0 dB>" — analogRead (12 bits, 11 dB) on ADC2's channels in order: GPIO4, 0, 2, 15, 13, 12, 14, 27,
// 25, 26 (CH0–CH9). With the idealized linear model 1.65 V reads 2048 (±3); 0.55 V at 0 dB reads 2048.
// No WiFi here: on a board WiFi takes ADC2 (see adc2-wifi).
const uint8_t PINS[] = {4, 0, 2, 15, 13, 12, 14, 27, 25, 26};

void setup() {
  Serial.begin(115200);
}

void loop() {
  analogReadResolution(12);
  Serial.print("adc2");
  for (uint8_t pin : PINS) {
    analogSetPinAttenuation(pin, ADC_11db);
    Serial.printf(" %d", analogRead(pin));
  }
  analogSetPinAttenuation(4, ADC_0db);
  Serial.printf(" z=%d\n", analogRead(4));
  delay(20);
}
