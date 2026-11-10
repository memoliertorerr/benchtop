// bmp280-spi — tests assert: a BMP280 on the ESP32's VSPI (SCK 18, MOSI 23, MISO 19, CS 5), 4-wire
// SPI, driven with the datasheet's registers and compensation code (no library): it prints "id
// 0x58", reads the trimming words in one burst, sets standby 62.5 ms and filter x16, then normal
// mode (T x2, P x16), and every 500 ms prints "t <celsius> p <hPa>" (2 decimals) at 115200 baud.

#include <SPI.h>

const int CS = 5;
uint16_t dig_T1, dig_P1;
int16_t dig_T2, dig_T3, dig_P2, dig_P3, dig_P4, dig_P5, dig_P6, dig_P7, dig_P8, dig_P9;
int32_t tFine;
SPISettings settings(1000000, MSBFIRST, SPI_MODE0);

void readBlock(uint8_t reg, uint8_t *out, uint8_t n) {
  SPI.beginTransaction(settings);
  digitalWrite(CS, LOW);
  SPI.transfer(reg | 0x80);
  for (uint8_t i = 0; i < n; i++) out[i] = SPI.transfer(0);
  digitalWrite(CS, HIGH);
  SPI.endTransaction();
}

void write8(uint8_t reg, uint8_t value) {
  SPI.beginTransaction(settings);
  digitalWrite(CS, LOW);
  SPI.transfer(reg & 0x7F);
  SPI.transfer(value);
  digitalWrite(CS, HIGH);
  SPI.endTransaction();
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

void setup() {
  Serial.begin(115200);
  pinMode(CS, OUTPUT);
  digitalWrite(CS, HIGH);
  SPI.begin(18, 19, 23, CS);
  uint8_t id;
  readBlock(0xD0, &id, 1);
  Serial.printf("id 0x%02X\n", id);
  uint8_t c[24];
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
  write8(0xF5, (1 << 5) | (4 << 2));         // standby 62.5 ms, filter x16
  write8(0xF4, (2 << 5) | (5 << 2) | 0x03);  // T x2, P x16, normal
}

void loop() {
  delay(500);
  uint8_t d[6];
  readBlock(0xF7, d, 6);
  int32_t adcP = ((uint32_t)d[0] << 12) | ((uint32_t)d[1] << 4) | (d[2] >> 4);
  int32_t adcT = ((uint32_t)d[3] << 12) | ((uint32_t)d[4] << 4) | (d[5] >> 4);
  float t = compensateT(adcT) / 100.0;
  float p = compensateP(adcP) / 25600.0;
  Serial.printf("t %.2f p %.2f\n", t, p);
}
