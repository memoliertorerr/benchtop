// mega/analog-hi — tests assert: all 16 analog inputs, A0–A7 (PF0–7) and A8–A15 (PK0–7, chosen
// with ADCSRB.MUX5), printed every 100 ms at 115200 baud as one line of 16 readings separated by
// spaces; each reads its volts × 1024 / 5 (±2).
void setup() {
  Serial.begin(115200);
}

void loop() {
  for (uint8_t i = 0; i < 16; i++) {
    Serial.print(analogRead(A0 + i));
    Serial.print(i < 15 ? ' ' : '\n');
  }
  delay(100);
}
