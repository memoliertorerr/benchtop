// gpio-input — tests assert (BT34): a button from D4 (GPIO4) to GND with INPUT_PULLUP; while it
// is pressed the LED on D2 (GPIO2) is on, within 2 ms of the press, and off again within 2 ms of
// the release.
void setup() {
  pinMode(4, INPUT_PULLUP);
  pinMode(2, OUTPUT);
}

void loop() {
  digitalWrite(2, digitalRead(4) == LOW ? HIGH : LOW);
  delay(1);
}
