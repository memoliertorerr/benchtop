// bargraph — tests assert: a 10-LED bar graph with bar n's anode on D(12-n) (bar 1 on D11 …
// bar 10 on D2, each through 220 ohm) and every cathode to GND shows bars 1..6 lit (D11..D6
// HIGH) and bars 7..10 dark (D5..D2 LOW), steadily.
void setup() {
  for (uint8_t pin = 2; pin <= 11; pin++) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, pin >= 6 ? HIGH : LOW);
  }
}

void loop() {
}
