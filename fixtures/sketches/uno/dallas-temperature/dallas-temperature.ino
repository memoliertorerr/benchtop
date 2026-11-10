// dallas-temperature — tests assert: two DS18B20s on pin 2 (a 4.7 kOhm pull-up to 5V) under
// OneWire 2.3.8 and DallasTemperature 4.0.6. Setup prints "count <n>", each sensor's address as
// "addr <i> 28-<serial, MSB first>", "parasite no" (or "yes"), sets 11 bits on every sensor and
// the second sensor's alarms (high 25, low 20). Then each second: requestTemperatures(),
// "took <ms> ms", "t<i> <celsius, 4 decimals>" by address, and "alarms <n>" from alarmSearch.

#include <OneWire.h>
#include <DallasTemperature.h>

OneWire oneWire(2);
DallasTemperature sensors(&oneWire);
DeviceAddress addresses[4];
int count = 0;

void printAddress(const DeviceAddress a) {
  Serial.print("28-");
  for (int i = 6; i >= 1; i--) {
    if (a[i] < 0x10) Serial.print('0');
    Serial.print(a[i], HEX);
  }
}

void setup() {
  Serial.begin(115200);
  sensors.begin();
  count = sensors.getDeviceCount();
  if (count > 4) count = 4;
  Serial.print("count ");
  Serial.println(count);
  for (int i = 0; i < count; i++) {
    sensors.getAddress(addresses[i], i);
    Serial.print("addr ");
    Serial.print(i);
    Serial.print(' ');
    printAddress(addresses[i]);
    Serial.println();
  }
  Serial.println(sensors.isParasitePowerMode() ? "parasite yes" : "parasite no");
  sensors.setResolution(11);
  if (count > 1) {
    sensors.setHighAlarmTemp(addresses[1], 25);
    sensors.setLowAlarmTemp(addresses[1], 20);
  }
}

void loop() {
  unsigned long start = millis();
  sensors.requestTemperatures();
  Serial.print("took ");
  Serial.print(millis() - start);
  Serial.println(" ms");
  for (int i = 0; i < count; i++) {
    Serial.print('t');
    Serial.print(i);
    Serial.print(' ');
    Serial.println(sensors.getTempC(addresses[i]), 4);
  }
  DeviceAddress found;
  int alarms = 0;
  sensors.resetAlarmSearch();
  while (sensors.alarmSearch(found)) alarms++;
  Serial.print("alarms ");
  Serial.println(alarms);
  delay(1000);
}
