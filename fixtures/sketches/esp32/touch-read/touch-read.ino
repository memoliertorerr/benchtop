// touch-read (ESP32) — tests assert (BT159): touchRead on T0 (GPIO4) and T3 (GPIO15) every 50 ms,
// printed at 115200 baud as "t0 <value> t3 <value>". The ESP32's (touch version 1) readings fall
// when a pad is touched (more capacitance, fewer charge cycles in its measuring window); after
// "touch ready" every line is a reading.
void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("touch ready");
}

void loop() {
  uint16_t t0 = touchRead(T0);
  uint16_t t3 = touchRead(T3);
  Serial.printf("t0 %u t3 %u\n", (unsigned)t0, (unsigned)t3);
  delay(50);
}
