// button-pullup — tests assert: D2 is INPUT_PULLUP and D13 (PB5) mirrors !D2: pressing a button
// from D2 to GND lights D13 within 1 ms; releasing it turns D13 off.
void setup() {
  pinMode(2, INPUT_PULLUP);
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, digitalRead(2) == LOW ? HIGH : LOW);
}
