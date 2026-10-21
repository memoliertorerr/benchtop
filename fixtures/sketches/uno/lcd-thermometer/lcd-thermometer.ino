// lcd-thermometer — tests assert (BT43): a DHT22 on D2 (Adafruit's DHT library) read every 2 s,
// shown on a 16x2 LCD behind a PCF8574 backpack at 0x27: "Temp   24.0 C" on row 0 and
// "Humid  40.0 %" on row 1. The LCD writer is this sketch's own (LiquidCrystal_I2C isn't
// installed): P0 = RS, P2 = E, P3 = backlight, P4..P7 = D4..D7.
#include <DHT.h>
#include <Wire.h>

DHT dht(2, DHT22);

const uint8_t LCD = 0x27;
const uint8_t RS = 0x01;
const uint8_t EN = 0x04;
const uint8_t BACKLIGHT = 0x08;

void expanderWrite(uint8_t value) {
  Wire.beginTransmission(LCD);
  Wire.write(value | BACKLIGHT);
  Wire.endTransmission();
}

// Puts the high nibble of `bits` on D7..D4 and pulses E.
void write4(uint8_t bits, uint8_t mode) {
  uint8_t value = (bits & 0xF0) | mode;
  expanderWrite(value);
  expanderWrite(value | EN);
  delayMicroseconds(1);
  expanderWrite(value);
  delayMicroseconds(50);
}

void send(uint8_t value, uint8_t mode) {
  write4(value, mode);
  write4(value << 4, mode);
}

void command(uint8_t value) { send(value, 0); }

void print(const char *text) {
  while (*text) send(*text++, RS);
}

void setCursor(uint8_t col, uint8_t row) {
  command(0x80 | (col + (row ? 0x40 : 0x00)));
}

void lcdBegin() {
  delay(50);
  expanderWrite(0);
  // The HD44780 "initialization by instruction" sequence, then 4-bit mode.
  write4(0x30, 0);
  delayMicroseconds(4500);
  write4(0x30, 0);
  delayMicroseconds(4500);
  write4(0x30, 0);
  delayMicroseconds(150);
  write4(0x20, 0);
  command(0x28);  // 4-bit, two lines, 5x8 dots
  command(0x0C);  // display on, cursor off
  command(0x01);  // clear
  delay(2);
  command(0x06);  // left to right
}

void setup() {
  Wire.begin();
  lcdBegin();
  dht.begin();
}

void loop() {
  float temperature = dht.readTemperature();
  float humidity = dht.readHumidity();
  char line[17];
  char number[8];
  dtostrf(temperature, 5, 1, number);
  snprintf(line, sizeof line, "Temp  %s C   ", number);
  setCursor(0, 0);
  print(line);
  dtostrf(humidity, 5, 1, number);
  snprintf(line, sizeof line, "Humid %s %%   ", number);
  setCursor(0, 1);
  print(line);
  delay(2000);
}
