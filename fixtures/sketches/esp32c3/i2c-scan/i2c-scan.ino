// i2c-scan — tests assert (BT93): Wire.begin() (the C3's defaults: SDA 8 / SCL 9) probes
// addresses 1–126 and prints "found 0x.." for each that ACKs, then "done": with an SSD1306 and a
// DS1307 on the bus exactly "found 0x3C", "found 0x68", "done"; with nothing attached only
// "done". Then every second it reads the DS1307's seconds register and prints "sec=<bcd hex>".
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin();
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) Serial.printf("found 0x%02X\n", a);
  }
  Serial.println("done");
}

void loop() {
  delay(1000);
  Wire.beginTransmission(0x68);
  Wire.write(0);
  if (Wire.endTransmission() != 0) return;
  if (Wire.requestFrom(0x68, 1) == 1) Serial.printf("sec=%02X\n", Wire.read());
}
