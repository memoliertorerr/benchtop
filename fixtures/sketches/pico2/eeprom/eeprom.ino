// Pico 2 EEPROM (BT65): EEPROM.commit() erases and programs the last flash sector through the
// RP2350 bootrom's flash functions (Arm code its RISC-V half runs under varmulet), so the bytes
// survive a reset. On UART0 (Serial1): "boot <n>" with the count read back, then "saved <n+1>".
#include <EEPROM.h>

void setup() {
  Serial1.begin(115200);
  EEPROM.begin(256);
  uint8_t boots = EEPROM.read(0);
  if (boots == 0xff) boots = 0;
  Serial1.printf("boot %d\n", boots);
  EEPROM.write(0, boots + 1);
  bool ok = EEPROM.commit();
  Serial1.printf("saved %d %s\n", boots + 1, ok ? "ok" : "failed");
}

void loop() {
  delay(1000);
}
