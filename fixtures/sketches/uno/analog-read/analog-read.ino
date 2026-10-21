// analog-read — tests assert: every 100 ms UART0 at 115200 baud prints analogRead(A0) as a
// decimal line: 0 V → 0, 2.5 V → 511 or 512, 5 V → 1023 (AVcc reference).
void setup() {
  Serial.begin(115200);
}

void loop() {
  Serial.println(analogRead(A0));
  delay(100);
}
