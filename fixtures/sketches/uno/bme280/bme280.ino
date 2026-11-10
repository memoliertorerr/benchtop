// bme280 — tests assert: a BME280 on I2C at 0x76 (SDA A4, SCL A5), driven with the datasheet's
// registers and compensation code (no library): it prints "id 0x60", reads the trimming words,
// then every second starts a forced measurement (T, P and H at x1), waits for status bit 3 to
// clear, prints "wait <ms> ms" once, and prints "t <celsius> p <hPa> h <%>" (2 decimals) at
// 115200 baud.

#include <Wire.h>

const uint8_t ADDR = 0x76;
uint16_t dig_T1, dig_P1;
int16_t dig_T2, dig_T3, dig_P2, dig_P3, dig_P4, dig_P5, dig_P6, dig_P7, dig_P8, dig_P9, dig_H2, dig_H4, dig_H5;
uint8_t dig_H1, dig_H3;
int8_t dig_H6;
int32_t tFine;

uint8_t read8(uint8_t reg) {
  Wire.beginTransmission(ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom(ADDR, (uint8_t)1);
  return Wire.read();
}

void readBlock(uint8_t reg, uint8_t *out, uint8_t n) {
  Wire.beginTransmission(ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom(ADDR, n);
  for (uint8_t i = 0; i < n; i++) out[i] = Wire.read();
}

void write8(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(ADDR);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
}

int32_t compensateT(int32_t adc) {
  int32_t var1 = ((((adc >> 3) - ((int32_t)dig_T1 << 1))) * ((int32_t)dig_T2)) >> 11;
  int32_t var2 = (((((adc >> 4) - ((int32_t)dig_T1)) * ((adc >> 4) - ((int32_t)dig_T1))) >> 12) * ((int32_t)dig_T3)) >> 14;
  tFine = var1 + var2;
  return (tFine * 5 + 128) >> 8;
}

uint32_t compensateP(int32_t adc) {
  int64_t var1 = ((int64_t)tFine) - 128000;
  int64_t var2 = var1 * var1 * (int64_t)dig_P6;
  var2 = var2 + ((var1 * (int64_t)dig_P5) << 17);
  var2 = var2 + (((int64_t)dig_P4) << 35);
  var1 = ((var1 * var1 * (int64_t)dig_P3) >> 8) + ((var1 * (int64_t)dig_P2) << 12);
  var1 = (((((int64_t)1) << 47) + var1)) * ((int64_t)dig_P1) >> 33;
  if (var1 == 0) return 0;
  int64_t p = 1048576 - adc;
  p = (((p << 31) - var2) * 3125) / var1;
  var1 = (((int64_t)dig_P9) * (p >> 13) * (p >> 13)) >> 25;
  var2 = (((int64_t)dig_P8) * p) >> 19;
  p = ((p + var1 + var2) >> 8) + (((int64_t)dig_P7) << 4);
  return (uint32_t)p;
}

uint32_t compensateH(int32_t adc) {
  int32_t v = (tFine - ((int32_t)76800));
  v = (((((adc << 14) - (((int32_t)dig_H4) << 20) - (((int32_t)dig_H5) * v)) + ((int32_t)16384)) >> 15) *
       (((((((v * ((int32_t)dig_H6)) >> 10) * (((v * ((int32_t)dig_H3)) >> 11) + ((int32_t)32768))) >> 10) + ((int32_t)2097152)) * ((int32_t)dig_H2) + 8192) >> 14));
  v = (v - (((((v >> 15) * (v >> 15)) >> 7) * ((int32_t)dig_H1)) >> 4));
  v = (v < 0 ? 0 : v);
  v = (v > 419430400 ? 419430400 : v);
  return (uint32_t)(v >> 12);
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Serial.print("id 0x");
  Serial.println(read8(0xD0), HEX);
  uint8_t c[26];
  readBlock(0x88, c, 24);
  dig_T1 = c[0] | (c[1] << 8);
  dig_T2 = c[2] | (c[3] << 8);
  dig_T3 = c[4] | (c[5] << 8);
  dig_P1 = c[6] | (c[7] << 8);
  dig_P2 = c[8] | (c[9] << 8);
  dig_P3 = c[10] | (c[11] << 8);
  dig_P4 = c[12] | (c[13] << 8);
  dig_P5 = c[14] | (c[15] << 8);
  dig_P6 = c[16] | (c[17] << 8);
  dig_P7 = c[18] | (c[19] << 8);
  dig_P8 = c[20] | (c[21] << 8);
  dig_P9 = c[22] | (c[23] << 8);
  dig_H1 = read8(0xA1);
  readBlock(0xE1, c, 7);
  dig_H2 = c[0] | (c[1] << 8);
  dig_H3 = c[2];
  dig_H4 = ((int16_t)(int8_t)c[3] << 4) | (c[4] & 0x0F);
  dig_H5 = ((int16_t)(int8_t)c[5] << 4) | (c[4] >> 4);
  dig_H6 = (int8_t)c[6];
}

bool firstWait = true;

void loop() {
  write8(0xF2, 0x01);                        // humidity x1
  write8(0xF4, (1 << 5) | (1 << 2) | 0x01);  // T x1, P x1, forced
  unsigned long start = millis();
  while (read8(0xF3) & 0x08) {
  }
  if (firstWait) {
    Serial.print("wait ");
    Serial.print(millis() - start);
    Serial.println(" ms");
    firstWait = false;
  }
  uint8_t d[8];
  readBlock(0xF7, d, 8);
  int32_t adcP = ((uint32_t)d[0] << 12) | ((uint32_t)d[1] << 4) | (d[2] >> 4);
  int32_t adcT = ((uint32_t)d[3] << 12) | ((uint32_t)d[4] << 4) | (d[5] >> 4);
  int32_t adcH = ((uint32_t)d[6] << 8) | d[7];
  float t = compensateT(adcT) / 100.0;
  float p = compensateP(adcP) / 25600.0;
  float h = compensateH(adcH) / 1024.0;
  Serial.print("t ");
  Serial.print(t, 2);
  Serial.print(" p ");
  Serial.print(p, 2);
  Serial.print(" h ");
  Serial.println(h, 2);
  delay(1000);
}
