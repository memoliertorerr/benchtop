// ledc-fade — tests assert (BT35): analogWrite(2, 64) puts GPIO2 at 1 kHz (period 1.000 ms
// ±0.1 %), high 25.0 % ±0.5 % (Arduino-ESP32 2.0.17's defaults: 1 kHz, 8 bits, channels taken
// from 15 down); ledcSetup(0, 5000, 13) + ledcAttachPin(4, 0) + ledcWrite(0, 4096) puts D4 at
// 5 kHz, 50 %. Then every second ledcWrite switches D4 between 25 % and 50 %: the change takes
// effect on a period boundary (analogWrite isn't used for that: in 2.0.17 it re-runs ledcSetup,
// which resets the timer). Prints "ready" after setup.
bool quarter = false;

void setup() {
  Serial.begin(115200);
  analogWrite(2, 64);
  ledcSetup(0, 5000, 13);
  ledcAttachPin(4, 0);
  ledcWrite(0, 4096);
  Serial.println("ready");
}

void loop() {
  delay(1000);
  quarter = !quarter;
  ledcWrite(0, quarter ? 2048 : 4096);
}
