// oled-spi — tests assert: Adafruit_SSD1306 (128x64) on software SPI, Adafruit's example pins
// (MOSI 9, CLK 10, DC 11, CS 12, RESET 13), draws "SPI OLED" at text size 2 at (16, 8), a filled
// triangle and the corner pixels (0,0) and (127,63), calls display(), then prints "FB:" + the
// 1024 getBuffer() bytes as uppercase hex + CRLF at 115200 baud. Then every second it redraws a
// counter at (52, 52) in text size 1 and prints "count <n>".
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define OLED_MOSI 9
#define OLED_CLK 10
#define OLED_DC 11
#define OLED_CS 12
#define OLED_RESET 13

Adafruit_SSD1306 display(128, 64, OLED_MOSI, OLED_CLK, OLED_DC, OLED_RESET, OLED_CS);
uint16_t count = 0;

void setup() {
  Serial.begin(115200);
  if (!display.begin(SSD1306_SWITCHCAPVCC)) {
    Serial.println(F("alloc failed"));
    for (;;) {
    }
  }
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(16, 8);
  display.print(F("SPI OLED"));
  display.fillTriangle(10, 50, 30, 30, 50, 50, SSD1306_WHITE);
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
  delay(1000);
  count++;
  display.fillRect(52, 52, 40, 8, SSD1306_BLACK);
  display.setTextSize(1);
  display.setCursor(52, 52);
  display.print(count);
  display.display();
  Serial.print(F("count "));
  Serial.println(count);
}
