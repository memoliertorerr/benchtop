// regulator-meter (BT85) — tests assert: every 200 ms UART0 at 115200 baud prints the regulator's
// output as "OUT = <volts> V" with two decimals: A0 reads it through a 10 kΩ / 10 kΩ divider, so
// OUT = analogRead(A0) × 5 / 1023 × 2. A 7805 fed 9 V prints "OUT = 5.00 V"; fed 6 V it has dropped
// out and prints "OUT = 4.00 V".
void setup() {
  Serial.begin(115200);
}

void loop() {
  float out = analogRead(A0) * 5.0 / 1023.0 * 2.0;
  Serial.print("OUT = ");
  Serial.print(out, 2);
  Serial.println(" V");
  delay(200);
}
