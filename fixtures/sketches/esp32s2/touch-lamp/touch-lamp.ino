// touch-lamp (ESP32-S2) — the gallery's touch example (BT157): a touch pad on T5 (GPIO5) switches
// the DevKitM-1's RGB LED (a WS2812 on GPIO18) on — warm white, (255, 160, 60) — and off, once per
// touch (touchAttachInterrupt with a threshold of 1500 over the pad's first reading: the S2 calls it
// on the touch and on the release; touchInterruptGetLastStatus says which). Prints "touch lamp
// ready", the pad's touchRead value every 250 ms ("touch <value>"), and "lamp on" / "lamp off".
volatile bool changed = false;
bool lamp = false;

void IRAM_ATTR onTouch() {
  changed = true;
}

void setup() {
  Serial.begin(115200);
  delay(100);
  neopixelWrite(RGB_BUILTIN, 0, 0, 0);
  touchAttachInterrupt(T5, onTouch, 1500);
  Serial.println("touch lamp ready");
}

void loop() {
  static uint32_t last = 0;
  if (changed) {
    changed = false;
    if (touchInterruptGetLastStatus(T5)) { // a touch, not its release
      lamp = !lamp;
      if (lamp) neopixelWrite(RGB_BUILTIN, 255, 160, 60);
      else neopixelWrite(RGB_BUILTIN, 0, 0, 0);
      Serial.println(lamp ? "lamp on" : "lamp off");
    }
  }
  if (millis() - last >= 250) {
    last = millis();
    Serial.printf("touch %u\n", (unsigned)touchRead(T5));
  }
  delay(10);
}
