// ssd1306-raw — tests assert: raw Wire transactions to an SSD1306 at 0x3C (no library):
// 1. Init with Co=1 control bytes: charge pump on, display on, segment remap A1, COM scan C8
//    (identity mapping), page addressing.
// 2. Page mode: every page p gets 128 data bytes, 0xFF for even p and 0x00 for odd p (horizontal
//    stripes 8 rows tall), sent as 0x40 data streams of 16 bytes.
// 3. Vertical mode with window columns 64..95 and pages 2..5: 128 data bytes, the k-th written to
//    page 2 + k % 4, column 64 + k / 4, value 0x0F for even columns and 0xF0 for odd ones; the last
//    two bytes go as Co=1 data (0xC0 b 0xC0 b).
// 4. At 0x3D: Wire.endTransmission() of a page-mode fill with 0x81 (all pages) is printed as
//    "nack3D=<n>" (2 when no device answers, 0 when one does).
// 5. Repeated START at 0x50: write register 0x05, restart, read 2 bytes; prints
//    "reg=<count>" then " <b0> <b1>" in decimal for each byte received.
// Then "done", all at 115200 baud.
#include <Wire.h>

void commands(uint8_t address, const uint8_t *bytes, uint8_t count) {
  Wire.beginTransmission(address);
  for (uint8_t i = 0; i < count; i++) {
    Wire.write(0x80);  // Co=1, D/C=0: one command byte follows
    Wire.write(bytes[i]);
  }
  Wire.endTransmission();
}

uint8_t pageFill(uint8_t address, uint8_t page, uint8_t value) {
  const uint8_t setPage[] = {(uint8_t)(0xB0 | page), 0x00, 0x10};
  commands(address, setPage, 3);
  uint8_t result = 0;
  for (uint8_t chunk = 0; chunk < 8; chunk++) {
    Wire.beginTransmission(address);
    Wire.write(0x40);  // Co=0, D/C=1: data stream
    for (uint8_t i = 0; i < 16; i++) Wire.write(value);
    uint8_t r = Wire.endTransmission();
    if (r != 0) result = r;
  }
  return result;
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  const uint8_t init[] = {0x8D, 0x14, 0xAF, 0xA1, 0xC8, 0x20, 0x02};
  commands(0x3C, init, sizeof init);
  for (uint8_t page = 0; page < 8; page++) pageFill(0x3C, page, page % 2 == 0 ? 0xFF : 0x00);

  const uint8_t vertical[] = {0x20, 0x01, 0x21, 64, 95, 0x22, 2, 5};
  commands(0x3C, vertical, sizeof vertical);
  for (uint8_t k = 0; k < 126; k += 14) {
    Wire.beginTransmission(0x3C);
    Wire.write(0x40);
    for (uint8_t i = k; i < k + 14 && i < 126; i++) Wire.write(((i / 4) % 2 == 0) ? 0x0F : 0xF0);
    Wire.endTransmission();
  }
  Wire.beginTransmission(0x3C);
  for (uint8_t i = 126; i < 128; i++) {
    Wire.write(0xC0);  // Co=1, D/C=1: one data byte follows
    Wire.write(((i / 4) % 2 == 0) ? 0x0F : 0xF0);
  }
  Wire.endTransmission();

  const uint8_t init3D[] = {0x8D, 0x14, 0xAF, 0xA1, 0xC8, 0x20, 0x02};
  commands(0x3D, init3D, sizeof init3D);
  uint8_t nack = 0;
  for (uint8_t page = 0; page < 8; page++) {
    uint8_t r = pageFill(0x3D, page, 0x81);
    if (r != 0) nack = r;
  }
  Serial.print(F("nack3D="));
  Serial.println(nack);

  Wire.beginTransmission(0x50);
  Wire.write(0x05);
  Wire.endTransmission(false);
  uint8_t count = Wire.requestFrom((uint8_t)0x50, (uint8_t)2);
  Serial.print(F("reg="));
  Serial.print(count);
  while (Wire.available()) {
    Serial.print(' ');
    Serial.print(Wire.read());
  }
  Serial.println();
  Serial.println(F("done"));
}

void loop() {
}
