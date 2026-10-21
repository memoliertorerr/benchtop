// ssd1306-adafruit — tests assert: Adafruit_SSD1306 (128x64, I2C 0x3C) draws a border, "Benchtop"
// at text size 2, a filled circle and the corner pixels (0,0) and (127,63), calls display(), then
// prints "FB:" + the 1024 getBuffer() bytes as uppercase hex + CRLF at 115200 baud. Then:
// invertDisplay(true) at 1.0 s, dim(true) at 1.5 s, DISPLAYOFF at 2.0 s, DISPLAYON at 2.5 s.
// At 2.6 s it prints "same:", sets one more pixel and calls display() 50 times, then prints
// "same done". After that a counter loop redraws the frame and prints "fps=<n>" every second:
// the number of complete display() calls in that simulated second.
// If begin() fails (the 1 KB buffer can't be allocated) it prints "alloc failed" and halts.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);
uint8_t stage = 0;
uint16_t counter = 0;
uint16_t frames = 0;
unsigned long second = 0;

void setup() {
  Serial.begin(115200);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println(F("alloc failed"));
    for (;;) {
    }
  }
  display.clearDisplay();
  display.drawRect(4, 4, 120, 56, SSD1306_WHITE);
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(16, 12);
  display.print(F("Benchtop"));
  display.fillCircle(64, 44, 10, SSD1306_WHITE);
  display.drawPixel(0, 0, SSD1306_WHITE);
  display.drawPixel(127, 63, SSD1306_WHITE);
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
  unsigned long ms = millis();
  if (stage == 0 && ms >= 1000) {
    display.invertDisplay(true);
    stage = 1;
  } else if (stage == 1 && ms >= 1500) {
    display.dim(true);
    stage = 2;
  } else if (stage == 2 && ms >= 2000) {
    display.ssd1306_command(SSD1306_DISPLAYOFF);
    stage = 3;
  } else if (stage == 3 && ms >= 2500) {
    display.ssd1306_command(SSD1306_DISPLAYON);
    stage = 4;
  } else if (stage == 4 && ms >= 2600) {
    Serial.println(F("same:"));
    display.drawPixel(64, 0, SSD1306_WHITE);
    for (uint8_t i = 0; i < 50; i++) display.display();
    Serial.println(F("same done"));
    second = millis();
    stage = 5;
  } else if (stage == 5) {
    display.fillRect(90, 40, 30, 16, SSD1306_BLACK);
    display.setTextSize(1);
    display.setCursor(92, 44);
    display.print(counter++);
    display.display();
    frames++;
    if (millis() - second >= 1000) {
      Serial.print(F("fps="));
      Serial.println(frames);
      frames = 0;
      second += 1000;
    }
  }
}
