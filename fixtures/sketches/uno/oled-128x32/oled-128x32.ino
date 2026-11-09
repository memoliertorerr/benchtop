// oled-128x32 — tests assert: Adafruit_SSD1306 (128x32, I2C 0x3C) draws a frame round the panel and
// "Benchtop" at text size 2 at (16, 9), calls display(), then prints "FB:" + the 512 getBuffer()
// bytes as uppercase hex + CRLF at 115200 baud. Then, every 6 s: "scroll" — startscrollleft(0, 3)
// for 4 s, stopscroll(), a redraw, "home".
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 32, &Wire, -1);

void draw() {
  display.clearDisplay();
  display.drawRect(0, 0, 128, 32, SSD1306_WHITE);
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(16, 9);
  display.print(F("Benchtop"));
  display.display();
}

void setup() {
  Serial.begin(115200);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println(F("alloc failed"));
    for (;;) {
    }
  }
  draw();
  Serial.print(F("FB:"));
  const uint8_t *buffer = display.getBuffer();
  for (uint16_t i = 0; i < 512; i++) {
    if (buffer[i] < 16) Serial.print('0');
    Serial.print(buffer[i], HEX);
  }
  Serial.println();
}

void loop() {
  delay(2000);
  Serial.println(F("scroll"));
  display.startscrollleft(0x00, 0x03);
  delay(4000);
  display.stopscroll();
  draw();
  Serial.println(F("home"));
}
