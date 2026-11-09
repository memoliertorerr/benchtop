// oled-spi — tests assert: Adafruit_SSD1306 (128x64) on the ESP32's hardware SPI (VSPI: SCK 18,
// MOSI 23; DC 16, CS 5, RESET 17) draws "ESP32" at text size 2 at (34, 4) and a frame, calls
// display(), then prints "FB:" + the 1024 getBuffer() bytes as uppercase hex + CRLF at 115200 baud.
// Then every 250 ms it redraws the uptime ("up 12.3 s" at (10, 30), text size 1) and a bar along
// the bottom whose length follows the seconds (4 px a second, wrapping at 120), and prints
// "tick <n>" once a second.
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define OLED_DC 16
#define OLED_CS 5
#define OLED_RESET 17

Adafruit_SSD1306 display(128, 64, &SPI, OLED_DC, OLED_RESET, OLED_CS);
unsigned long lastTick = 0;
uint32_t ticks = 0;

void setup() {
  Serial.begin(115200);
  if (!display.begin(SSD1306_SWITCHCAPVCC)) {
    Serial.println("alloc failed");
    for (;;) {
      delay(1000);
    }
  }
  display.clearDisplay();
  display.drawRect(0, 0, 128, 64, SSD1306_WHITE);
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(34, 4);
  display.print("ESP32");
  display.display();
  Serial.print("FB:");
  const uint8_t *buffer = display.getBuffer();
  for (uint16_t i = 0; i < 1024; i++) {
    if (buffer[i] < 16) Serial.print('0');
    Serial.print(buffer[i], HEX);
  }
  Serial.println();
}

void loop() {
  delay(250);
  unsigned long ms = millis();
  display.fillRect(1, 24, 126, 39, SSD1306_BLACK);
  display.setTextSize(1);
  display.setCursor(10, 30);
  display.print("up ");
  display.print(ms / 1000.0, 1);
  display.print(" s");
  display.fillRect(4, 52, ((ms / 1000) * 4) % 120, 6, SSD1306_WHITE);
  display.display();
  if (ms - lastTick >= 1000) {
    lastTick += 1000;
    ticks++;
    Serial.print("tick ");
    Serial.println(ticks);
  }
}
