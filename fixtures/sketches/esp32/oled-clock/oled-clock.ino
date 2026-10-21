// oled-clock — tests assert (BT43): the ESP32 version of the OLED clock. A DS1307 at 0x68 and a
// 128x64 SSD1306 at 0x3C on I2C (SDA = GPIO21, SCL = GPIO22); the time large, the date below, and
// "YYYY-MM-DD hh:mm:ss" printed every second (115200 baud). The clock starts at the DS1307 part's
// "start" time (2026-01-01 00:00:00 by default).
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Wire.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);
const uint8_t RTC = 0x68;

uint8_t fromBcd(uint8_t b) { return (b >> 4) * 10 + (b & 0x0F); }

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.setTextColor(SSD1306_WHITE);
}

void loop() {
  uint8_t r[7];
  Wire.beginTransmission(RTC);
  Wire.write(0);  // from the seconds register
  Wire.endTransmission();
  Wire.requestFrom(RTC, (uint8_t)7);
  for (uint8_t i = 0; i < 7; i++) r[i] = Wire.read();

  char text[24];
  snprintf(text, sizeof text, "20%02u-%02u-%02u %02u:%02u:%02u", fromBcd(r[6]), fromBcd(r[5] & 0x1F), fromBcd(r[4] & 0x3F),
           fromBcd(r[2] & 0x3F), fromBcd(r[1]), fromBcd(r[0] & 0x7F));
  Serial.println(text);

  display.clearDisplay();
  display.setTextSize(2);
  display.setCursor(16, 16);
  display.print(text + 11);  // hh:mm:ss
  display.setTextSize(1);
  display.setCursor(34, 44);
  text[10] = '\0';
  display.print(text);  // the date
  display.display();
  delay(1000);
}
