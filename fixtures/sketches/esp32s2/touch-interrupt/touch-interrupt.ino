// touch-interrupt (ESP32-S2) — tests assert (BT155): touchAttachInterrupt on T5 (GPIO5) with a
// threshold of 1500 (Arduino's S2 TouchInterrupt example's), which the S2 calls on a touch and on
// its release. Prints at 115200 baud "ready", then for each call "<touched|released> count <n>"
// (touchInterruptGetLastStatus, and the calls so far).
volatile uint32_t calls = 0;
volatile bool changed = false;

void IRAM_ATTR gotTouch() {
  calls++;
  changed = true;
}

void setup() {
  Serial.begin(115200);
  delay(100);
  touchAttachInterrupt(T5, gotTouch, 1500);
  Serial.println("ready");
}

void loop() {
  if (changed) {
    changed = false;
    Serial.printf("%s count %u\n", touchInterruptGetLastStatus(T5) ? "touched" : "released", (unsigned)calls);
  }
  delay(10);
}
