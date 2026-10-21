// analog-read — tests assert (BT61): a potentiometer's wiper on GP26 (ADC0), read at 12 bits
// every 100 ms and printed on USB serial ("adc=<0–4095>").
void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
}

void loop() {
  Serial.print("adc=");
  Serial.println(analogRead(26));
  delay(100);
}
