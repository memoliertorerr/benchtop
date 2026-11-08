// flash-info (ESP32 and ESP32-S3) — tests assert (BT143): built with the board menu's Flash Size
// 16MB. Prints the size the image header gives (ESP.getFlashChipSize()) and the chip's own, from
// its JEDEC ID (esp_flash_read_id: manufacturer, type, density as a power of two):
// "flash 16777216 chip 16777216 id <hex>". On a board whose chip is smaller than the header says,
// ESP-IDF's startup refuses to go on, so nothing is printed.
#include "esp_flash.h"

void setup() {
  Serial.begin(115200);
  delay(100);
  uint32_t id = 0;
  esp_flash_read_id(NULL, &id);
  uint32_t chip = 1u << (id & 0xff);
  Serial.printf("flash %u chip %u id %06x\n", ESP.getFlashChipSize(), chip, id);
}

void loop() {
  delay(1000);
}
