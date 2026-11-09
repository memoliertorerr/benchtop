// touch-interrupt (ESP32) — tests assert (BT159): touchAttachInterrupt on T0 (GPIO4) with a threshold
// of 40 (Arduino's ESP32 TouchInterrupt example's): the ESP32 calls it after every measurement in
// which the pad reads below 40 — repeatedly while it stays touched. Prints at 115200 baud "ready",
// then every 100 ms "calls <n>" (the calls so far) and the pad's reading.
volatile uint32_t calls = 0;

void IRAM_ATTR gotTouch() {
  calls++;
}

void setup() {
  Serial.begin(115200);
  delay(100);
  touchAttachInterrupt(T0, gotTouch, 40);
  Serial.println("ready");
}

void loop() {
  Serial.printf("calls %u t0 %u\n", (unsigned)calls, (unsigned)touchRead(T0));
  delay(100);
}
