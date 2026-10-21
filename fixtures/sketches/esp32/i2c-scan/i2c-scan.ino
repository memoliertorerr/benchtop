// i2c-scan — tests assert (BT36): Wire.begin() (SDA 21 / SCL 22) probes addresses 1–126 and
// prints "found 0x.." for each that ACKs, then "done": with a DS1307 and an SSD1306 on the bus
// exactly "found 0x3C", "found 0x68", "done"; with nothing attached only "done".
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
}
