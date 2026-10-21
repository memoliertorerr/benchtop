// nano/blink — tests assert: on the Nano, D13 (PB5, the L LED) toggles every 1,000 ms (±1 %),
// starting high; UART0 at 115200 baud prints "nano\r\n" once at startup.
void setup() {
  Serial.begin(115200);
  Serial.println("nano");
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}
