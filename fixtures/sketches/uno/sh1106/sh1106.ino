// sh1106 — tests assert: Adafruit_SH110X's SH1106G (128x64, I2C 0x3C) draws "SH1106" at text size
// 2 at (28, 8), a circle at (64, 44) radius 12 and the corner pixels (0,0) and (127,63), calls
// display(), then prints "FB:" + the 1024 getBuffer() bytes as uppercase hex + CRLF at 115200 baud.
// Then every second it redraws a counter at (100, 52) in text size 1 and prints "count <n>".
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>

Adafruit_SH1106G display(128, 64, &Wire, -1);
uint16_t count = 0;

void setup() {
  Serial.begin(115200);
  if (!display.begin(0x3C, true)) {
    Serial.println(F("alloc failed"));
    for (;;) {
    }
  }
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SH110X_WHITE);
  display.setCursor(28, 8);
  display.print(F("SH1106"));
  display.drawCircle(64, 44, 12, SH110X_WHITE);
  display.drawPixel(0, 0, SH110X_WHITE);
  display.drawPixel(127, 63, SH110X_WHITE);
  display.display();
  Serial.print(F("FB:"));
  const uint8_t *buffer = display.getBuffer();
  for (uint16_t i = 0; i < 1024; i++) {
    if (buffer[i] < 16) Serial.print('0');
    Serial.print(buffer[i], HEX);
  }
  Serial.println();
}

void loop() {
  delay(1000);
  count++;
  display.fillRect(100, 52, 27, 8, SH110X_BLACK);
  display.setTextSize(1);
  display.setCursor(100, 52);
  display.print(count);
  display.display();
  Serial.print(F("count "));
  Serial.println(count);
}
