// blink — tests assert: D13 (PB5) toggles every 500 ms (8,000,000 cycles at 16 MHz, ±0.5%),
// starting high; UART0 at 9600 baud emits exactly "hello\r\n", once, at startup.
void setup() {
  Serial.begin(9600);
  Serial.println("hello");
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(500);
  digitalWrite(13, LOW);
  delay(500);
}
