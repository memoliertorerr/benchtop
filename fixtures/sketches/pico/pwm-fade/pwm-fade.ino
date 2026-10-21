// pwm-fade — tests assert (BT61): analogWrite on GP15 (an LED through 220 Ω) at arduino-pico's
// defaults (1 kHz, 8-bit range): duty 0, 64, 128, 192, 255, 200 ms each, then again.
const uint8_t LED = 15;
const int STEPS[] = {0, 64, 128, 192, 255};

void setup() {
  pinMode(LED, OUTPUT);
}

void loop() {
  for (int duty : STEPS) {
    analogWrite(LED, duty);
    delay(200);
  }
}
