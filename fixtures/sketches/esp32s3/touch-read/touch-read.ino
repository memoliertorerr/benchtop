// touch-read (ESP32-S3) — tests assert (BT158; the ESP32-S2's BT155 sketch): touchRead on T1 (GPIO1) and T5 (GPIO5) every
// 50 ms, printed at 115200 baud as "t1 <value> t5 <value>". The S3's readings rise, as the S2's, when a pad is
// touched (more capacitance, a longer measurement); after "touch ready" every line is a reading.
void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("touch ready");
}

void loop() {
  uint32_t t1 = touchRead(T1);
  uint32_t t5 = touchRead(T5);
  Serial.printf("t1 %u t5 %u\n", (unsigned)t1, (unsigned)t5);
  delay(50);
}
