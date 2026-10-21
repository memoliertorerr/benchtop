// eeprom — tests assert: after writing bytes 0..15 to EEPROM addresses 0..15 and reading them
// back, UART0 at 9600 baud prints exactly "ok\r\n" (or "bad\r\n" on any mismatch).
#include <EEPROM.h>

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < 16; i++) EEPROM.write(i, i);
  bool ok = true;
  for (int i = 0; i < 16; i++) {
    if (EEPROM.read(i) != i) ok = false;
  }
  Serial.println(ok ? "ok" : "bad");
}

void loop() {
}
