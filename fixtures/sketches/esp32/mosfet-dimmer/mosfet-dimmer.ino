// mosfet-dimmer — tests assert (BT170): a pot on GPIO34 (ADC1) sets the duty of a 1 kHz, 8-bit
// LEDC PWM on GPIO25, which drives an IRLZ44N's gate (a 10 kΩ pull-down holds it off at boot); the
// MOSFET switches LEDs on a 9 V battery, so they dim with the pot. Every 200 ms it prints
// "duty <0–255>".
const int POT = 34;
const int GATE = 25;

void setup() {
  Serial.begin(115200);
  ledcSetup(0, 1000, 8);
  ledcAttachPin(GATE, 0);
}

void loop() {
  int duty = analogRead(POT) >> 4;
  ledcWrite(0, duty);
  Serial.printf("duty %d\n", duty);
  delay(200);
}
