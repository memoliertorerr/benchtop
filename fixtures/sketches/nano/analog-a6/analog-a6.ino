// nano/analog-a6 — tests assert: A6 and A7 (ADC6/ADC7, the Nano's analog-only pins) read like
// A0: a line "<A6> <A7>" every 100 ms at 115200 baud; 1.25 V reads 256 and 3.75 V reads 768 (±2).
void setup() {
  Serial.begin(115200);
}

void loop() {
  Serial.print(analogRead(A6));
  Serial.print(' ');
  Serial.println(analogRead(A7));
  delay(100);
}
