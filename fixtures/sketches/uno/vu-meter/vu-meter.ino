// vu-meter — tests assert (BT43): a microphone's OUT on A0 and a 10-LED bar graph on D2..D11
// (through 220 Ω). Every 50 ms the loudest swing of the samples (peak to peak) lights 0..10 bars
// (a swing of 200 counts — about 1 V — or more lights all ten); quiet keeps them dark.
const uint8_t BARS[10] = {2, 3, 4, 5, 6, 7, 8, 9, 10, 11};

void setup() {
  for (uint8_t i = 0; i < 10; i++) pinMode(BARS[i], OUTPUT);
}

void loop() {
  int low = 1023;
  int high = 0;
  unsigned long start = millis();
  while (millis() - start < 50) {  // listen for 50 ms
    int v = analogRead(A0);
    if (v < low) low = v;
    if (v > high) high = v;
  }
  int swing = high - low;
  int lit = constrain(map(swing, 10, 200, 0, 10), 0, 10);
  for (uint8_t i = 0; i < 10; i++) digitalWrite(BARS[i], i < lit ? HIGH : LOW);
}
