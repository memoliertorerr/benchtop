// i2c-scan — tests assert: Wire probes addresses 1..126 once; UART0 at 115200 baud prints one
// line "0xNN" (two uppercase hex digits) per address that ACKs, then "done". With one device at
// 0x3C the output is exactly "0x3C\r\ndone\r\n".
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin();
  for (uint8_t address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) {
      Serial.print("0x");
      if (address < 16) Serial.print('0');
      Serial.println(address, HEX);
    }
  }
  Serial.println("done");
}

void loop() {
}
