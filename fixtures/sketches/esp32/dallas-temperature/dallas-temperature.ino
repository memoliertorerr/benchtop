// dallas-temperature — tests assert: one DS18B20 on GPIO4 (a 4.7 kOhm pull-up to 3V3) under
// OneWire 2.3.8 and DallasTemperature 4.0.6. Setup prints "count <n>", then at 9 bits and at 12:
// requestTemperatures() and "<bits> bit <celsius, 4 decimals> C in <ms> ms". Then each second
// "t <celsius> C".

#include <OneWire.h>
#include <DallasTemperature.h>

OneWire oneWire(4);
DallasTemperature sensors(&oneWire);

void measure(uint8_t bits) {
  sensors.setResolution(bits);
  unsigned long start = millis();
  sensors.requestTemperatures();
  unsigned long took = millis() - start;
  Serial.printf("%u bit %.4f C in %lu ms\n", bits, sensors.getTempCByIndex(0), took);
}

void setup() {
  Serial.begin(115200);
  sensors.begin();
  Serial.printf("count %u\n", sensors.getDeviceCount());
  measure(9);
  measure(12);
}

void loop() {
  delay(1000);
  sensors.requestTemperatures();
  Serial.printf("t %.4f C\n", sensors.getTempCByIndex(0));
}
