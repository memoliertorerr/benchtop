// i2c-scan — tests assert (the Pico's sketch on the Pico 2's RISC-V cores): Wire (I2C0: SDA GP4, SCL GP5) probes every address 0x08–0x77 with a
// one-byte write, as bus scanners and drivers looking for their chip do (arduino-pico bit-bangs a
// zero-length probe, a different path), then reads one byte from the empty 0x22. Every 100 ms one
// line on USB serial: "scan <n>: <ACKed addresses> | codes <c0> <c1> <c2> <c3> <c4> <c5> | read
// <bytes> | timeout <0/1> | <us> us" — endTransmission's results counted by value (0 ACK; a NACKed
// address gives 4 in this core, the pico-sdk's PICO_ERROR_GENERIC, not 2; 5 a timeout), what
// requestFrom returned, Wire's timeout flag and how long the scan and the read took.
#include <Wire.h>

int pass = 0;

void setup() {
  Serial.begin(115200);
  Wire.setSDA(4);
  Wire.setSCL(5);
  Wire.begin();
}

void loop() {
  char found[64] = "";
  int codes[6] = {0, 0, 0, 0, 0, 0};
  uint32_t start = micros();
  for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
    Wire.beginTransmission(addr);
    Wire.write(0);
    uint8_t err = Wire.endTransmission();
    if (err < 6) codes[err]++;
    size_t used = strlen(found);
    if (err == 0 && used + 6 < sizeof(found)) snprintf(found + used, sizeof(found) - used, " 0x%02X", addr);
  }
  int read = Wire.requestFrom(0x22, 1);
  uint32_t us = micros() - start;
  int timedOut = Wire.getTimeoutFlag() ? 1 : 0;
  Wire.clearTimeoutFlag();
  Serial.printf("scan %d:%s | codes %d %d %d %d %d %d | read %d | timeout %d | %lu us\r\n", pass++, found, codes[0], codes[1],
                codes[2], codes[3], codes[4], codes[5], read, timedOut, (unsigned long)us);
  delay(100);
}
