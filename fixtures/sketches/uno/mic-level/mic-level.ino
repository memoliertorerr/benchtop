// mic-level — tests assert (BT41): a microphone's OUT on A0, read in a loop; the rising crossings
// of a slowly tracked midpoint (with ±8 counts of hysteresis) are counted, and every 500 ms the
// tone's frequency (crossings × 2) is printed on Serial (115200): 440 for a 440 Hz tone.
void setup() {
  Serial.begin(115200);
}

void loop() {
  static long average = 512L << 8;  // the midpoint × 256
  static bool above = false;
  static unsigned int crossings = 0;
  static unsigned long start = millis();
  int v = analogRead(A0);
  average += v - (average >> 8);
  int middle = average >> 8;
  if (!above && v > middle + 8) {
    above = true;
    crossings++;
  } else if (above && v < middle - 8) {
    above = false;
  }
  if (millis() - start >= 500) {
    Serial.println(crossings * 2);
    crossings = 0;
    start += 500;
  }
}
