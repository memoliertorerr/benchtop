// bmp280-adafruit — tests assert: a BMP280 on the ESP32's VSPI (SCK 18, MOSI 23, MISO 19, CS 5)
// under Adafruit BMP280 3.0.0 (hardware SPI). Setup prints "begin ok" (or "begin failed") and sets
// normal mode, T x2, P x16, filter x16, standby 63 ms; then every 500 ms "t <celsius> p <hPa>"
// (2 decimals) at 115200 baud.

#include <SPI.h>
#include <Adafruit_BMP280.h>

Adafruit_BMP280 bmp(5);

void setup() {
  Serial.begin(115200);
  bool ok = bmp.begin();
  Serial.println(ok ? "begin ok" : "begin failed");
  bmp.setSampling(Adafruit_BMP280::MODE_NORMAL, Adafruit_BMP280::SAMPLING_X2, Adafruit_BMP280::SAMPLING_X16,
                  Adafruit_BMP280::FILTER_X16, Adafruit_BMP280::STANDBY_MS_63);
}

void loop() {
  delay(500);
  Serial.printf("t %.2f p %.2f\n", bmp.readTemperature(), bmp.readPressure() / 100.0);
}
