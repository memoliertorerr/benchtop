// max7219 — tests assert: an FC-16 4-in-1 MAX7219 matrix on hardware SPI (DIN 11, CLK 13, CS 10),
// driven as MD_MAX72XX does: every frame is four 16-bit words with CS low, the leftmost module's
// word first (it ends in the far chip). Setup: display test off, scan limit 7, no decode,
// intensity 2, normal operation; then four 8x8 pictures, left to right a heart, a smiley, an
// arrow and a checkerboard, and prints "drawn" at 115200 baud. Then every 250 ms the intensity
// steps through 0, 4, 8, 15 and around, printing "intensity <k>".

#include <SPI.h>

const int CS_PIN = 10;
const int MODULES = 4;

const uint8_t PICTURES[MODULES][8] = {
  {0x00, 0x66, 0xFF, 0xFF, 0xFF, 0x7E, 0x3C, 0x18},
  {0x3C, 0x42, 0xA5, 0x81, 0xA5, 0x99, 0x42, 0x3C},
  {0x08, 0x0C, 0xFE, 0xFF, 0xFE, 0x0C, 0x08, 0x00},
  {0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55},
};

void sendAll(uint8_t reg, uint8_t data) {
  digitalWrite(CS_PIN, LOW);
  for (int m = 0; m < MODULES; m++) {
    SPI.transfer(reg);
    SPI.transfer(data);
  }
  digitalWrite(CS_PIN, HIGH);
}

void drawRow(uint8_t row) {
  digitalWrite(CS_PIN, LOW);
  for (int m = 0; m < MODULES; m++) {
    SPI.transfer(row + 1);
    SPI.transfer(PICTURES[m][row]);
  }
  digitalWrite(CS_PIN, HIGH);
}

void setup() {
  Serial.begin(115200);
  pinMode(CS_PIN, OUTPUT);
  digitalWrite(CS_PIN, HIGH);
  SPI.begin();
  SPI.beginTransaction(SPISettings(8000000, MSBFIRST, SPI_MODE0));
  sendAll(0x0F, 0);
  sendAll(0x0B, 7);
  sendAll(0x09, 0);
  sendAll(0x0A, 2);
  sendAll(0x0C, 1);
  for (uint8_t row = 0; row < 8; row++) drawRow(row);
  SPI.endTransaction();
  Serial.println("drawn");
}

const uint8_t STEPS[] = {0, 4, 8, 15};
uint8_t step = 0;

void loop() {
  delay(250);
  SPI.beginTransaction(SPISettings(8000000, MSBFIRST, SPI_MODE0));
  sendAll(0x0A, STEPS[step]);
  SPI.endTransaction();
  Serial.print("intensity ");
  Serial.println(STEPS[step]);
  step = (step + 1) % 4;
}
