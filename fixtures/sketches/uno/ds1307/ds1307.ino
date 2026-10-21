// ds1307 — tests assert (raw Wire, RTClib isn't installed): setup sets a DS1307 at 0x68 to
// 2026-10-19 23:59:58 (24 h, CH=0), then prints "YYYY-MM-DD hh:mm:ss" right away and every second
// for 4 s (the fourth line is "2026-10-20 00:00:01"). Then:
//   CH: sets CH=1, waits 1.1 s, prints "frozen=1" if the seconds didn't move (else 0), clears CH;
//   RAM: writes 56 bytes (i*7+3) & 0xFF to 0x08..0x3F, reads them back, prints "ram=ok" or
//        "ram=bad <index>";
//   pointer: sets the pointer to 0x3F and reads two bytes, printing "wrap=<b0> <b1>" in decimal:
//        RAM byte 55 (132), then the seconds register (BCD, wrapped from 0x3F to 0x00);
// then "done". All at 115200 baud.
#include <Wire.h>

const uint8_t RTC = 0x68;

uint8_t bcd(uint8_t n) { return ((n / 10) << 4) | (n % 10); }
uint8_t dec(uint8_t b) { return (b >> 4) * 10 + (b & 0x0F); }

void writeRegs(uint8_t reg, const uint8_t *bytes, uint8_t count) {
  Wire.beginTransmission(RTC);
  Wire.write(reg);
  for (uint8_t i = 0; i < count; i++) Wire.write(bytes[i]);
  Wire.endTransmission();
}

void readRegs(uint8_t reg, uint8_t *bytes, uint8_t count) {
  Wire.beginTransmission(RTC);
  Wire.write(reg);
  Wire.endTransmission();
  Wire.requestFrom(RTC, count);
  for (uint8_t i = 0; i < count && Wire.available(); i++) bytes[i] = Wire.read();
}

void printTime() {
  uint8_t r[7];
  readRegs(0, r, 7);
  char line[20];
  snprintf(line, sizeof line, "20%02u-%02u-%02u %02u:%02u:%02u", dec(r[6]), dec(r[5] & 0x1F), dec(r[4] & 0x3F), dec(r[2] & 0x3F), dec(r[1]), dec(r[0] & 0x7F));
  Serial.println(line);
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  const uint8_t start[7] = {bcd(58), bcd(59), bcd(23), 2, bcd(19), bcd(10), bcd(26)};
  writeRegs(0, start, 7);
  unsigned long t0 = millis();
  for (uint8_t i = 0; i < 4; i++) {
    while (millis() - t0 < i * 1000UL) {
    }
    printTime();
  }

  uint8_t seconds;
  readRegs(0, &seconds, 1);
  uint8_t halted = seconds | 0x80;
  writeRegs(0, &halted, 1);
  delay(1100);
  uint8_t later;
  readRegs(0, &later, 1);
  Serial.print(F("frozen="));
  Serial.println(later == halted ? 1 : 0);
  uint8_t running = later & 0x7F;
  writeRegs(0, &running, 1);

  uint8_t ram[28];
  for (uint8_t half = 0; half < 2; half++) {
    for (uint8_t i = 0; i < 28; i++) ram[i] = ((half * 28 + i) * 7 + 3) & 0xFF;
    writeRegs(0x08 + half * 28, ram, 28);
  }
  int bad = -1;
  for (uint8_t half = 0; half < 2 && bad < 0; half++) {
    readRegs(0x08 + half * 28, ram, 28);
    for (uint8_t i = 0; i < 28; i++) {
      if (ram[i] != (((half * 28 + i) * 7 + 3) & 0xFF)) {
        bad = half * 28 + i;
        break;
      }
    }
  }
  if (bad < 0) {
    Serial.println(F("ram=ok"));
  } else {
    Serial.print(F("ram=bad "));
    Serial.println(bad);
  }

  uint8_t wrap[2];
  readRegs(0x3F, wrap, 2);
  Serial.print(F("wrap="));
  Serial.print(wrap[0]);
  Serial.print(' ');
  Serial.println(wrap[1]);
  Serial.println(F("done"));
}

void loop() {
}
