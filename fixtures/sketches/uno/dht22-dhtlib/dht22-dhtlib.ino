// dht22-dhtlib — tests assert: DHTlib's read22() (1 ms wake-up pulse) reads a DHT22 on D2 every
// 2.1 s and prints "T=<°C, 2 decimals> H=<%, 2 decimals>" at 115200 baud, or "read failed <code>".
#include <dht.h>

dht sensor;

void setup() {
  Serial.begin(115200);
}

void loop() {
  delay(2100);
  int8_t result = sensor.read22(2);
  if (result != DHTLIB_OK) {
    Serial.print(F("read failed "));
    Serial.println(result);
    return;
  }
  Serial.print(F("T="));
  Serial.print(sensor.temperature, 2);
  Serial.print(F(" H="));
  Serial.println(sensor.humidity, 2);
}
