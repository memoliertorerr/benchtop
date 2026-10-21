// dht22-adafruit — tests assert: Adafruit's DHT sensor library (1.4.6) reads a DHT22 on D2 every
// 2.1 s and prints "T=<°C, 2 decimals> H=<%, 2 decimals>" at 115200 baud ("read failed" if a
// read fails). With the part at 23.4 °C / 45.6 % the first line is "T=23.40 H=45.60".
#include <DHT.h>

DHT dht(2, DHT22);

void setup() {
  Serial.begin(115200);
  dht.begin();
}

void loop() {
  delay(2100);
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) {
    Serial.println(F("read failed"));
    return;
  }
  Serial.print(F("T="));
  Serial.print(t, 2);
  Serial.print(F(" H="));
  Serial.println(h, 2);
}
