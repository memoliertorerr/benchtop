// shift-chain — tests assert: two 74HC595s chained (the first's Q7S into the second's DS) on the
// SPI pins — DS on 11 (MOSI), SHCP on 13 (SCK), both latches on 10, the second's Q7S back on 12
// (MISO). The first byte sent ends in the far 595. Bit-banged A5 C3 ("soft A5C3"); 500 ms later
// SPI 5A 3C, printing what came back on MISO ("spi 5A3C back A5C3"); 500 ms later LSB-first SPI
// 01 80 ("lsb 0180": far 80, near 01).

#include <SPI.h>

const int latchPin = 10;
const int dataPin = 11;
const int clockPin = 13;

void latch() {
  digitalWrite(latchPin, HIGH);
  digitalWrite(latchPin, LOW);
}

void printHex(uint8_t b) {
  if (b < 0x10) Serial.print('0');
  Serial.print(b, HEX);
}

void setup() {
  Serial.begin(115200);
  pinMode(latchPin, OUTPUT);
  pinMode(dataPin, OUTPUT);
  pinMode(clockPin, OUTPUT);

  shiftOut(dataPin, clockPin, MSBFIRST, 0xA5);
  shiftOut(dataPin, clockPin, MSBFIRST, 0xC3);
  latch();
  Serial.println("soft A5C3");
  delay(500);

  SPI.begin();
  SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
  uint8_t far = SPI.transfer(0x5A);
  uint8_t near = SPI.transfer(0x3C);
  SPI.endTransaction();
  latch();
  Serial.print("spi 5A3C back ");
  printHex(far);
  printHex(near);
  Serial.println();
  delay(500);

  SPI.beginTransaction(SPISettings(4000000, LSBFIRST, SPI_MODE0));
  SPI.transfer(0x01);
  SPI.transfer(0x80);
  SPI.endTransaction();
  latch();
  Serial.println("lsb 0180");
}

void loop() {}
