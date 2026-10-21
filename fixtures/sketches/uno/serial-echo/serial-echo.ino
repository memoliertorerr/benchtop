// serial-echo — tests assert: every byte received on UART0 at 9600 baud is sent straight back
// (receiving "abc" transmits "abc").
void setup() {
  Serial.begin(9600);
}

void loop() {
  while (Serial.available() > 0) {
    Serial.write(Serial.read());
  }
}
