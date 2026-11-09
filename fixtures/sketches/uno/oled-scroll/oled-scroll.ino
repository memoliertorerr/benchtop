// oled-scroll — tests assert: Adafruit_SSD1306 (128x64, I2C 0x3C) draws "Benchtop" at text size 2
// at (16, 24) and a 2-pixel bar along the top, calls display() and prints "drawn". Then, again and
// again: "right" — startscrollright(0, 7) for 2 s, stopscroll(); "left" — startscrollleft(0, 7) for
// 2 s, stopscroll(); "diag" — startscrolldiagright(0, 7) for 2 s, stopscroll(); a 1 s pause after
// each; then it redraws the frame (display() puts the image back where it was drawn) and prints
// "again". Every line at 115200 baud.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);

void draw() {
  display.clearDisplay();
  display.fillRect(0, 0, 128, 2, SSD1306_WHITE);
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(16, 24);
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
  Serial.println(F("drawn"));
}

void loop() {
  Serial.println(F("right"));
  display.startscrollright(0x00, 0x07);
  delay(2000);
  display.stopscroll();
  delay(1000);
  Serial.println(F("left"));
  display.startscrollleft(0x00, 0x07);
  delay(2000);
  display.stopscroll();
  delay(1000);
  Serial.println(F("diag"));
  display.startscrolldiagright(0x00, 0x07);
  delay(2000);
  display.stopscroll();
  delay(1000);
  draw();
  Serial.println(F("again"));
}
