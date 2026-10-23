// blink — tests assert (BT92): GPIO8 (the C3 DevKitM-1's LED pin) is HIGH for 500 ms, then LOW for
// 500 ms, repeating.
void setup() {
  pinMode(8, OUTPUT);
}

void loop() {
  digitalWrite(8, HIGH);
  delay(500);
  digitalWrite(8, LOW);
  delay(500);
}
