// bme280-adafruit — tests assert: a BME280 at 0x76 (SDA A4, SCL A5) under Adafruit BME280 2.3.0.
// Setup prints "begin ok" (or "begin failed") and sets forced mode, x1 oversampling, no filter;
// then each second takeForcedMeasurement() and "t <celsius> p <hPa> h <%> alt <m>" (2 decimals; the
// altitude for 1013.25 hPa at sea level) at 115200 baud.

#include <Wire.h>
#include <Adafruit_BME280.h>

Adafruit_BME280 bme;

void setup() {
  Serial.begin(115200);
  bool ok = bme.begin(0x76);
  Serial.println(ok ? "begin ok" : "begin failed");
  bme.setSampling(Adafruit_BME280::MODE_FORCED, Adafruit_BME280::SAMPLING_X1, Adafruit_BME280::SAMPLING_X1,
                  Adafruit_BME280::SAMPLING_X1, Adafruit_BME280::FILTER_OFF);
}

void loop() {
  bme.takeForcedMeasurement();
  Serial.print("t ");
  Serial.print(bme.readTemperature(), 2);
  Serial.print(" p ");
  Serial.print(bme.readPressure() / 100.0, 2);
  Serial.print(" h ");
  Serial.print(bme.readHumidity(), 2);
  Serial.print(" alt ");
  Serial.println(bme.readAltitude(1013.25), 2);
  delay(1000);
}
