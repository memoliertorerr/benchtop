// thermostat — tests assert (BT56): an NTC module (OUT on A0; 10 kΩ, β 3950) and a heater
// switched by D7, with the L LED (D13) showing it. Below 24.5 °C the heater turns on, above
// 25.5 °C it turns off (±0.5 °C hysteresis around 25 °C). Every 250 ms it prints
// "t=<°C, 1 decimal> heater=<0|1>" at 115200 baud.
const uint8_t HEATER = 7, LED = 13;
const float BETA = 3950;
bool heating = false;

void setup() {
  Serial.begin(115200);
  pinMode(HEATER, OUTPUT);
  pinMode(LED, OUTPUT);
}

void loop() {
  int a = analogRead(A0);
  float celsius = 1 / (log(1 / (1023. / a - 1)) / BETA + 1.0 / 298.15) - 273.15;
  if (!heating && celsius < 24.5) heating = true;
  else if (heating && celsius > 25.5) heating = false;
  digitalWrite(HEATER, heating);
  digitalWrite(LED, heating);
  Serial.print("t=");
  Serial.print(celsius, 1);
  Serial.print(" heater=");
  Serial.println(heating);
  delay(250);
}
