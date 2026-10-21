// mpu6050 — tests assert (raw Wire; no MPU6050 library is installed): an MPU-6050 at 0x68.
// Prints, at 115200 baud: "WHO=0x68" (WHO_AM_I), "AZ0=<n>" (ACCEL_ZOUT read while PWR_MGMT_1 is
// still 0x40, SLEEP: 0), then wakes it (PWR_MGMT_1 = 0) and prints
// "AX=<n> AY=<n> AZ=<n> T=<n> GX=<n> GY=<n> GZ=<n>" (raw int16 from a 14-byte burst at 0x3B),
// sets ACCEL_CONFIG = 0x10 (+-8 g) and prints "AZ8=<n>", then "done".
#include <Wire.h>

#define MPU_ADDRESS 0x68

void writeReg(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU_ADDRESS);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
}

void readRegs(uint8_t reg, uint8_t *bytes, uint8_t count) {
  Wire.beginTransmission(MPU_ADDRESS);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)MPU_ADDRESS, count);
  for (uint8_t i = 0; i < count && Wire.available(); i++) bytes[i] = Wire.read();
}

int16_t word16(const uint8_t *bytes) { return (int16_t)((bytes[0] << 8) | bytes[1]); }

void setup() {
  Serial.begin(115200);
  Wire.begin();
  uint8_t who = 0;
  readRegs(0x75, &who, 1);
  Serial.print(F("WHO=0x"));
  Serial.println(who, HEX);
  uint8_t z[2] = {0xFF, 0xFF};
  readRegs(0x3F, z, 2);
  Serial.print(F("AZ0="));
  Serial.println(word16(z));

  writeReg(0x6B, 0x00);
  uint8_t data[14];
  readRegs(0x3B, data, 14);
  const char *names[7] = {"AX=", " AY=", " AZ=", " T=", " GX=", " GY=", " GZ="};
  for (uint8_t i = 0; i < 7; i++) {
    Serial.print(names[i]);
    Serial.print(word16(data + 2 * i));
  }
  Serial.println();

  writeReg(0x1C, 0x10);
  readRegs(0x3F, z, 2);
  Serial.print(F("AZ8="));
  Serial.println(word16(z));
  Serial.println(F("done"));
}

void loop() {
}
