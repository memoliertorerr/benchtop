// ledc-fade — tests assert (BT93): analogWrite(3, 64) puts GPIO3 at 1 kHz (period 1.000 ms
// ±0.1 %), high 25.0 % ±0.5 % (Arduino-ESP32 2.0.17's defaults: 1 kHz, 8 bits, channels taken
// from the top down); ledcSetup(0, 5000, 12) + ledcAttachPin(4, 0) + ledcWrite(0, 2048) puts
// GPIO4 at 5 kHz, 50 % (12 bits: on the C3 the core clocks LEDC from the 40 MHz crystal, which
// can't give 5 kHz at 13 bits). Then every second ledcWrite switches GPIO4 between 25 % and 50 %:
// the change takes effect on a period boundary. Prints "ready" after setup.
bool quarter = false;

void setup() {
  Serial.begin(115200);
  analogWrite(3, 64);
  ledcSetup(0, 5000, 12);
  ledcAttachPin(4, 0);
  ledcWrite(0, 2048);
  Serial.println("ready");
}

void loop() {
  delay(1000);
  quarter = !quarter;
  ledcWrite(0, quarter ? 1024 : 2048);
}
