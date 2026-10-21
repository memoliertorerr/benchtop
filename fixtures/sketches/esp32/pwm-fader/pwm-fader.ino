// pwm-fader — tests assert (BT43): a potentiometer on GPIO34 (ADC1, 12-bit) sets the brightness
// of an LED on GPIO18 through LEDC (channel 0, 5 kHz, 8-bit): duty = reading / 16. The reading is
// printed twice a second (115200 baud).
const int POT = 34;
const int LED = 18;

void setup() {
  Serial.begin(115200);
  ledcSetup(0, 5000, 8);  // channel 0, 5 kHz, 8-bit duty (0..255)
  ledcAttachPin(LED, 0);
}

void loop() {
  static unsigned long last = 0;
  int reading = analogRead(POT);  // 0 … 4095
  ledcWrite(0, reading / 16);     // 0 … 255
  if (millis() - last >= 500) {
    last = millis();
    Serial.println(reading);
  }
  delay(10);
}
