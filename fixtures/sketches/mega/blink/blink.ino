// mega/blink — tests assert: on the Mega, D13 (PB7, the L LED) toggles every 1,000 ms (±1 %),
// starting high; Serial (USART0) at 115200 baud prints "mega\r\n" once at startup.
void setup() {
  Serial.begin(115200);
  Serial.println("mega");
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}
