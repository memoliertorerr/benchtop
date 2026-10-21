// mic-level — tests assert (BT41): a microphone's OUT on GPIO34 (ADC1), read with analogRead in a
// loop; the rising crossings of a slowly tracked midpoint (±32 counts of hysteresis, 12-bit
// readings) are counted, and every 500 ms the tone's frequency (crossings × 2) is printed on
// Serial (115200): 440 for a 440 Hz tone. The CPU runs at 80 MHz — plenty for this loop, and a
// third of the instructions to emulate.
void setup() {
  setCpuFrequencyMhz(80);
  Serial.begin(115200);
}

void loop() {
  static long average = 2048L << 8;  // the midpoint × 256
  static bool above = false;
  static unsigned int crossings = 0;
  static unsigned long start = millis();
  int v = analogRead(34);
  average += v - (average >> 8);
  int middle = average >> 8;
  if (!above && v > middle + 32) {
    above = true;
    crossings++;
  } else if (above && v < middle - 32) {
    above = false;
  }
  if (millis() - start >= 500) {
    Serial.println(crossings * 2);
    crossings = 0;
    start += 500;
  }
}
