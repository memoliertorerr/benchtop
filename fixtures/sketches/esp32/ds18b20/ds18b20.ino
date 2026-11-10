// ds18b20 — tests assert: one DS18B20 on GPIO4 (a 4.7 kOhm pull-up to 3V3), driven as the OneWire
// library does on the ESP32 (GPIO's W1TS/W1TC registers inside a critical section; reset
// 480/70/410 us, write 1 10/55, write 0 65/5, read 3/10/53). Setup: Read ROM, printing "rom
// 28-<serial, MSB first> crc ok" (or "crc bad"), the supply ("power external" or "power
// parasite"), then at 9 bits (config 1Fh) a conversion polled until done, "9 bit <celsius, 4
// decimals> C in <ms> ms", and the same at 12 bits (7Fh), "12 bit ...". Then each second a 12-bit
// reading, "t <celsius> C".

#include "soc/gpio_struct.h"

const int PIN = 4;
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

inline void lineLow() {
  GPIO.out_w1tc = 1 << PIN;
  GPIO.enable_w1ts = 1 << PIN;
}
inline void lineRelease() { GPIO.enable_w1tc = 1 << PIN; }
inline uint8_t lineRead() { return (GPIO.in >> PIN) & 1; }

uint8_t owReset() {
  portENTER_CRITICAL(&mux);
  lineLow();
  portEXIT_CRITICAL(&mux);
  delayMicroseconds(480);
  portENTER_CRITICAL(&mux);
  lineRelease();
  delayMicroseconds(70);
  uint8_t present = !lineRead();
  portEXIT_CRITICAL(&mux);
  delayMicroseconds(410);
  return present;
}

void owWriteBit(uint8_t v) {
  portENTER_CRITICAL(&mux);
  lineLow();
  delayMicroseconds(v ? 10 : 65);
  lineRelease();
  portEXIT_CRITICAL(&mux);
  delayMicroseconds(v ? 55 : 5);
}

uint8_t owReadBit() {
  portENTER_CRITICAL(&mux);
  lineLow();
  delayMicroseconds(3);
  lineRelease();
  delayMicroseconds(10);
  uint8_t r = lineRead();
  portEXIT_CRITICAL(&mux);
  delayMicroseconds(53);
  return r;
}

void owWrite(uint8_t b) {
  for (uint8_t i = 0; i < 8; i++) owWriteBit((b >> i) & 1);
}

uint8_t owRead() {
  uint8_t b = 0;
  for (uint8_t i = 0; i < 8; i++) b |= owReadBit() << i;
  return b;
}

uint8_t crc8(const uint8_t *data, uint8_t len) {
  uint8_t crc = 0;
  while (len--) {
    uint8_t in = *data++;
    for (uint8_t i = 0; i < 8; i++) {
      uint8_t mix = (crc ^ in) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8C;
      in >>= 1;
    }
  }
  return crc;
}

float convert(unsigned long *took) {
  owReset();
  owWrite(0xCC);
  owWrite(0x44);
  unsigned long start = millis();
  while (owReadBit() == 0) {
  }
  *took = millis() - start;
  owReset();
  owWrite(0xCC);
  owWrite(0xBE);
  uint8_t pad[9];
  for (int i = 0; i < 9; i++) pad[i] = owRead();
  if (crc8(pad, 8) != pad[8]) return -999;
  return (int16_t)((pad[1] << 8) | pad[0]) / 16.0;
}

void setResolution(uint8_t config) {
  owReset();
  owWrite(0xCC);
  owWrite(0x4E);
  owWrite(75);
  owWrite(70);
  owWrite(config);
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN, INPUT);
  lineRelease();
  owReset();
  owWrite(0x33);
  uint8_t rom[8];
  for (int i = 0; i < 8; i++) rom[i] = owRead();
  Serial.print("rom 28-");
  for (int i = 6; i >= 1; i--) Serial.printf("%02X", rom[i]);
  Serial.println(crc8(rom, 7) == rom[7] ? " crc ok" : " crc bad");
  owReset();
  owWrite(0xCC);
  owWrite(0xB4);
  Serial.println(owReadBit() ? "power external" : "power parasite");
  unsigned long took;
  setResolution(0x1F);
  float t9 = convert(&took);
  Serial.printf("9 bit %.4f C in %lu ms\n", t9, took);
  setResolution(0x7F);
  float t12 = convert(&took);
  Serial.printf("12 bit %.4f C in %lu ms\n", t12, took);
}

void loop() {
  delay(1000);
  unsigned long took;
  Serial.printf("t %.4f C\n", convert(&took));
}
