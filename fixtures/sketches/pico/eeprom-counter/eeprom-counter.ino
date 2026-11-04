// eeprom-counter — tests assert (BT118): counts its boots with arduino-pico's EEPROM (a 256-byte
// copy in RAM, committed to the flash's last sector): reads the count at 0 (0xFF counts as 0),
// commits one more and prints "boot <n>" on Serial1 (UART0) at 115200 baud. Resets and uploads keep
// that sector, so each start prints the next number.
#include <EEPROM.h>

void setup() {
  Serial1.begin(115200);
  EEPROM.begin(256);
  uint8_t count = EEPROM.read(0);
  if (count == 0xff) count = 0;
  count++;
  EEPROM.write(0, count);
  EEPROM.commit();
  Serial1.printf("boot %d\n", count);
}

void loop() {
  delay(1000);
}
