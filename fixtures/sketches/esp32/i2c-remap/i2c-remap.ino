// i2c-remap — tests assert (BT36): Wire.begin(16, 17) routes I2C0 to GPIO16 (SDA) / GPIO17 (SCL)
// through the GPIO matrix: I2cController.pins() reports them, a DS1307 wired there is found
// ("found 0x68"), one on 21/22 isn't; then "done". It waits 5 ms after Wire.begin: the bench
// re-attaches bus devices at its next quantum boundary.
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin(16, 17);
  delay(5);
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) Serial.printf("found 0x%02X\n", a);
  }
  Serial.println("done");
}

void loop() {
  delay(1000);
}
