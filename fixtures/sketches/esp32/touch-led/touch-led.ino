// touch-led (ESP32) — the gallery's ESP32 touch example (BT161): a touch pad on T0 (GPIO4) lights
// the LED on GPIO2 (the DevKit's own blue LED, and the breadboard's red one) while a finger is on
// it. The ESP32's readings fall when touched: below 40 counts as touched (Arduino's ESP32 touch
// examples' threshold). Prints "touch <value>" every 200 ms and "led on" / "led off" on a change.
const int LED = 2;
const uint16_t THRESHOLD = 40;
bool lit = false;

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
  digitalWrite(LED, LOW);
  Serial.println("touch led ready");
}

void loop() {
  static uint32_t last = 0;
  uint16_t value = touchRead(T0);
  bool touched = value < THRESHOLD;
  if (touched != lit) {
    lit = touched;
    digitalWrite(LED, lit ? HIGH : LOW);
    Serial.println(lit ? "led on" : "led off");
  }
  if (millis() - last >= 200) {
    last = millis();
    Serial.printf("touch %u\n", (unsigned)value);
  }
  delay(20);
}
