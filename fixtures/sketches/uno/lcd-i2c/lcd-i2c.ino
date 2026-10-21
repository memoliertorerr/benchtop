// lcd-i2c — tests assert: a 16x2 LCD behind a PCF8574 backpack at 0x27 (P0=RS, P1=RW, P2=E,
// P3=backlight, P4..P7=D4..D7), driven by this sketch's own writer over Wire (LiquidCrystal_I2C
// is not installed). Same text as lcd-4bit: "Hello, Benchtop!" on row 0, "t=<seconds>" on row 1.
// The backlight goes off at 1.5 s. At startup UART0 (115200 baud) prints "nack=2": the result of
// Wire.endTransmission() for a probe of 0x3F, where nothing answers.
#include <Wire.h>

const uint8_t ADDRESS = 0x27;
const uint8_t RS = 0x01;
const uint8_t EN = 0x04;
const uint8_t BACKLIGHT = 0x08;
uint8_t backlight = BACKLIGHT;

void expanderWrite(uint8_t value) {
  Wire.beginTransmission(ADDRESS);
  Wire.write(value | backlight);
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

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.beginTransmission(0x3F);
  Serial.print("nack=");
  Serial.println(Wire.endTransmission());

  delay(50);
  expanderWrite(0);
  // The HD44780 "initialization by instruction" sequence, as LiquidCrystal does it.
  write4(0x30, 0);
  delayMicroseconds(4500);
  write4(0x30, 0);
  delayMicroseconds(4500);
  write4(0x30, 0);
  delayMicroseconds(150);
  write4(0x20, 0);
  command(0x28);  // 4-bit, 2 lines, 5x8 dots
  command(0x0C);  // display on, cursor off, blink off
  command(0x01);  // clear
  delayMicroseconds(2000);
  command(0x06);  // entry mode: increment, no shift
  print("Hello, Benchtop!");
}

unsigned long shown = 0xFFFFFFFF;
bool dark = false;

void loop() {
  unsigned long ms = millis();
  if (!dark && ms >= 1500) {
    dark = true;
    backlight = 0;
    expanderWrite(0);
  }
  unsigned long seconds = ms / 1000;
  if (seconds != shown) {
    shown = seconds;
    char digits[11];
    ultoa(seconds, digits, 10);
    setCursor(0, 1);
    print("t=");
    print(digits);
  }
}
