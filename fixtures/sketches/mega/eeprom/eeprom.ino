// mega/eeprom — tests assert: the 4 KiB EEPROM. Prints EEPROM.length() ("4096"), writes 0x11 at
// 0, 0x22 at 1024 and 0x33 at 4095, reads them back and prints "eeprom ok" (else "eeprom bad").
#include <EEPROM.h>

void setup() {
  Serial.begin(115200);
  Serial.println(EEPROM.length());
  EEPROM.write(0, 0x11);
  EEPROM.write(1024, 0x22);
  EEPROM.write(4095, 0x33);
  bool ok = EEPROM.read(0) == 0x11 && EEPROM.read(1024) == 0x22 && EEPROM.read(4095) == 0x33;
  Serial.println(ok ? "eeprom ok" : "eeprom bad");
}

void loop() {}
