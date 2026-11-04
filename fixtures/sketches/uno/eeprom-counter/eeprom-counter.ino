// eeprom-counter — tests assert (BT118): counts its boots in EEPROM. Reads the count at address 0
// (a fresh EEPROM's 0xFF counts as 0), stores one more and prints "boot <n>" at 9600 baud. Every
// reset, power cycle or upload of a sketch keeps the EEPROM, so each start prints the next number.
#include <EEPROM.h>

void setup() {
  Serial.begin(9600);
  byte count = EEPROM.read(0);
  if (count == 0xFF) count = 0;
  count++;
  EEPROM.write(0, count);
  Serial.print("boot ");
  Serial.println(count);
}

void loop() {
}
