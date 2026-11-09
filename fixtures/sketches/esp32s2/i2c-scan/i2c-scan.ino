// i2c-scan — tests assert (BT149): Wire.begin() (the S2's defaults: SDA 8 / SCL 9, I2C0) probes
// addresses 1–126 and prints "found 0x.." for each that ACKs, then Wire1.begin(39, 40) (I2C1)
// does the same as "found1 0x..", then "done". Then every second it reads the DS1307's seconds
// register on Wire and prints "sec=<bcd hex>".
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin();
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) Serial.printf("found 0x%02X\n", a);
  }
  Wire1.begin(39, 40);
  for (uint8_t a = 1; a < 127; a++) {
    Wire1.beginTransmission(a);
    if (Wire1.endTransmission() == 0) Serial.printf("found1 0x%02X\n", a);
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
