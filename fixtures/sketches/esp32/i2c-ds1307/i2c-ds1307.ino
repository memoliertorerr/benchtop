// i2c-ds1307 — tests assert (BT36): raw Wire register access to a DS1307 at 0x68 (no library)
// sets 12:34:56, reads the time back 3 s later and prints "12:34:59" (±1 s). Then one 1-byte
// register-pointer write at 100 kHz and one after Wire.setClock(400000) — the test times both —
// and "done".
#include <Wire.h>

static uint8_t bcd(uint8_t v) {
  return ((v / 10) << 4) | (v % 10);
}

static uint8_t dec(uint8_t v) {
  return (v >> 4) * 10 + (v & 0x0f);
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.beginTransmission(0x68);
  Wire.write(0x00);
  Wire.write(bcd(56));
  Wire.write(bcd(34));
  Wire.write(bcd(12));
  Wire.endTransmission();
  delay(3000);
  Wire.beginTransmission(0x68);
  Wire.write(0x00);
  Wire.endTransmission();
  Wire.requestFrom(0x68, 3);
  uint8_t s = dec(Wire.read() & 0x7f);
  uint8_t m = dec(Wire.read());
  uint8_t h = dec(Wire.read() & 0x3f);
  Serial.printf("%02u:%02u:%02u\n", h, m, s);
  Serial.flush();
  Wire.beginTransmission(0x68);
  Wire.write(0x08);
  Wire.endTransmission();
  Wire.setClock(400000);
  Wire.beginTransmission(0x68);
  Wire.write(0x08);
  Wire.endTransmission();
  Serial.println("done");
}

void loop() {
  delay(1000);
}
