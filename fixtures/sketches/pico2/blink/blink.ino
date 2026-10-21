// Pico 2 blink (BT65): the onboard LED (GP25) toggles every 500 ms on the RP2350's RISC-V cores.
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
