// prefs-counter — tests assert (BT118; the ESP32 sketch built for the ESP32-C3): counts its boots with Preferences (NVS namespace "bench",
// key "boots", a UInt) and prints "boot <n>" at 115200 baud, n one more each start: resets, power
// cycles and uploads keep NVS. A line "restart" on Serial prints "restarting" and calls
// ESP.restart(); "clear" clears the namespace and prints "cleared".
#include <Preferences.h>

Preferences prefs;

void setup() {
  Serial.begin(115200);
  prefs.begin("bench", false);
  unsigned int boots = prefs.getUInt("boots", 0) + 1;
  prefs.putUInt("boots", boots);
  Serial.printf("boot %u\n", boots);
}

void loop() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line == "restart") {
      Serial.println("restarting");
      Serial.flush();
      ESP.restart();
    }
    if (line == "clear") {
      prefs.clear();
      Serial.println("cleared");
    }
  }
  delay(10);
}
