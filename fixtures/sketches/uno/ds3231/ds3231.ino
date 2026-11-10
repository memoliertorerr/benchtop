// ds3231 — tests assert: a ZS-042 module (DS3231 at 0x68, AT24C32 at 0x57) on I2C (SDA A4, SCL A5),
// its SQW on pin 2, driven with the datasheet's registers (no library). Setup prints "osf <0|1>",
// sets 2026-11-10 12:34:50, clears OSF and EN32kHz, sets alarm 1 for seconds 55 (A1M2–A1M4 set) with
// INTCN and A1IE, and forces a temperature conversion, printing "temp <celsius> after <ms> ms". It
// writes 40 bytes ("Benchtop" repeated) to the EEPROM at 30 in four writes that keep within its
// pages and Wire's 32-byte buffer, ACK-polling after each ("polls <n>"), and reads them back in two
// halves, the second from the EEPROM's own address counter ("eeprom ok" or "eeprom bad"). Each second it prints the
// time "hh:mm:ss"; the INT/SQW falling edge (pin 2's interrupt) prints "alarm hh:mm:ss" and clears
// A1F. At 12:35:00 it turns on the 1 Hz square wave (INTCN off) and prints "sqw high <ms> ms"
// (pulseIn on pin 2).

#include <Wire.h>

const uint8_t RTC = 0x68;
const uint8_t EEPROM_ADDR = 0x57;
volatile bool alarmed = false;

uint8_t bcd(uint8_t n) { return ((n / 10) << 4) | (n % 10); }
uint8_t unbcd(uint8_t b) { return (b >> 4) * 10 + (b & 0x0F); }

void writeRegs(uint8_t reg, const uint8_t *data, uint8_t n) {
  Wire.beginTransmission(RTC);
  Wire.write(reg);
  for (uint8_t i = 0; i < n; i++) Wire.write(data[i]);
  Wire.endTransmission();
}

void write1(uint8_t reg, uint8_t value) { writeRegs(reg, &value, 1); }

uint8_t read1(uint8_t reg) {
  Wire.beginTransmission(RTC);
  Wire.write(reg);
  Wire.endTransmission();
  Wire.requestFrom(RTC, (uint8_t)1);
  return Wire.read();
}

void printTime(const char *label) {
  Wire.beginTransmission(RTC);
  Wire.write(0x00);
  Wire.endTransmission();
  Wire.requestFrom(RTC, (uint8_t)3);
  uint8_t s = Wire.read(), m = Wire.read(), h = Wire.read();
  char line[24];
  snprintf(line, sizeof line, "%s%02u:%02u:%02u", label, unbcd(h & 0x3F), unbcd(m), unbcd(s));
  Serial.println(line);
}

void onAlarm() { alarmed = true; }

int pageWrite(uint16_t at, const uint8_t *data, uint8_t n) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(at >> 8);
  Wire.write(at & 0xFF);
  for (uint8_t i = 0; i < n; i++) Wire.write(data[i]);
  Wire.endTransmission();
  int polls = 0;
  for (;;) {
    Wire.beginTransmission(EEPROM_ADDR);
    if (Wire.endTransmission() == 0) return polls;
    polls++;
  }
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  pinMode(2, INPUT_PULLUP);
  Serial.print("osf ");
  Serial.println(read1(0x0F) >> 7);
  const uint8_t time[7] = {bcd(50), bcd(34), bcd(12), 3, bcd(10), bcd(11), bcd(26)};
  writeRegs(0x00, time, 7);
  write1(0x0F, 0x00);
  const uint8_t alarm[4] = {bcd(55), 0x80, 0x80, 0x80};
  writeRegs(0x07, alarm, 4);
  write1(0x0E, 0x05 | 0x20);  // INTCN, A1IE, CONV
  unsigned long start = millis();
  while (read1(0x0E) & 0x20) {
  }
  int8_t whole = (int8_t)read1(0x11);
  uint8_t quarter = read1(0x12) >> 6;
  Serial.print("temp ");
  Serial.print(whole + quarter * 0.25, 2);
  Serial.print(" after ");
  Serial.print(millis() - start);
  Serial.println(" ms");
  attachInterrupt(digitalPinToInterrupt(2), onAlarm, FALLING);

  uint8_t text[40];
  for (uint8_t i = 0; i < 40; i++) text[i] = "Benchtop"[i % 8];
  int polls = pageWrite(30, text, 2);  // 30, 31: the rest of the page
  polls += pageWrite(32, text + 2, 16);
  polls += pageWrite(48, text + 18, 16);
  polls += pageWrite(64, text + 34, 6);
  Serial.print("polls ");
  Serial.println(polls);
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(0);
  Wire.write(30);
  Wire.endTransmission();
  bool ok = true;
  Wire.requestFrom(EEPROM_ADDR, (uint8_t)20);
  for (uint8_t i = 0; i < 20; i++) ok = ok && Wire.read() == text[i];
  Wire.requestFrom(EEPROM_ADDR, (uint8_t)20);  // a current-address read: on from 50
  for (uint8_t i = 20; i < 40; i++) ok = ok && Wire.read() == text[i];
  Serial.println(ok ? "eeprom ok" : "eeprom bad");
}

uint8_t lastSecond = 0xFF;
bool squareOn = false;

void loop() {
  if (alarmed) {
    alarmed = false;
    printTime("alarm ");
    write1(0x0F, 0x00);
  }
  uint8_t s = read1(0x00);
  if (s != lastSecond) {
    lastSecond = s;
    printTime("");
    if (!squareOn && s == 0x00) {
      squareOn = true;
      detachInterrupt(digitalPinToInterrupt(2));
      write1(0x0E, 0x00);  // INTCN off, RS 00: 1 Hz
      unsigned long high = pulseIn(2, HIGH, 3000000UL);
      Serial.print("sqw high ");
      Serial.print(high / 1000);
      Serial.println(" ms");
    }
  }
}
