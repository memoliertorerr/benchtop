// ledc-fade — tests assert (BT125): analogWrite(4, 64) puts GPIO4 at 1 kHz, high 25 % (Arduino-
// ESP32 2.0.17's defaults: 1 kHz, 8 bits, channels taken from the top down — the S3 has 8);
// ledcSetup(0, 5000, 12) + ledcAttachPin(5, 0) + ledcWrite(0, 2048) puts GPIO5 at 5 kHz, 50 %.
// Then every second ledcWrite switches GPIO5 between 25 % and 50 %. Prints "ready" after setup.
bool quarter = false;

void setup() {
  Serial.begin(115200);
  analogWrite(4, 64);
  ledcSetup(0, 5000, 12);
  ledcAttachPin(5, 0);
  ledcWrite(0, 2048);
  Serial.println("ready");
}

void loop() {
  delay(1000);
  quarter = !quarter;
  ledcWrite(0, quarter ? 1024 : 2048);
}
