// shift-in — tests assert: two 74HC165s chained (the far one's Q7 into the near one's DS, the far
// DS on GND) on the SPI pins: PL on 8, CE on 10, CP on 13 (SCK), the near Q7 on 12 (MISO). It reads
// the 16 inputs bit-banged (load, then Q7 before each of 16 clocks; near byte first) and prints
// "soft <hex4>", then on hardware SPI (load, CE low, two transfers) and prints "spi <hex4>" at 115200
// baud. Then every 20 ms it reads them on SPI and prints "in <hex4>" when they change.

#include <SPI.h>

const int PL = 8;
const int CE = 10;
const int CP = 13;
const int Q7 = 12;

void load() {
  digitalWrite(PL, LOW);
  delayMicroseconds(5);
  digitalWrite(PL, HIGH);
}

uint16_t readSoft() {
  load();
  digitalWrite(CE, LOW);
  uint16_t v = 0;
  for (int i = 0; i < 16; i++) {
    v = (v << 1) | digitalRead(Q7);
    digitalWrite(CP, HIGH);
    digitalWrite(CP, LOW);
  }
  digitalWrite(CE, HIGH);
  return v;
}

uint16_t readSpi() {
  load();
  SPI.beginTransaction(SPISettings(2000000, MSBFIRST, SPI_MODE0));
  digitalWrite(CE, LOW);
  uint16_t v = SPI.transfer(0) << 8;
  v |= SPI.transfer(0);
  digitalWrite(CE, HIGH);
  SPI.endTransaction();
  return v;
}

void printHex(const char *label, uint16_t v) {
  char line[16];
  snprintf(line, sizeof line, "%s%04X", label, v);
  Serial.println(line);
}

uint16_t last;

void setup() {
  Serial.begin(115200);
  pinMode(PL, OUTPUT);
  pinMode(CE, OUTPUT);
  pinMode(CP, OUTPUT);
  pinMode(Q7, INPUT);
  digitalWrite(PL, HIGH);
  digitalWrite(CE, HIGH);
  digitalWrite(CP, LOW);
  printHex("soft ", readSoft());
  SPI.begin();
  last = readSpi();
  printHex("spi ", last);
}

void loop() {
  delay(20);
  uint16_t v = readSpi();
  if (v != last) {
    last = v;
    printHex("in ", v);
  }
}
