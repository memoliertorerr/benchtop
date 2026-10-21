// analog-pullup — tests assert: A0 is set INPUT_PULLUP (the ATmega328P's ~35 kΩ pull-up), then
// every 100 ms UART0 at 115200 baud prints analogRead(A0) as a decimal line. With 10 kΩ from A0
// to GND that is 1.111 V → 227.
void setup() {
  Serial.begin(115200);
  pinMode(A0, INPUT_PULLUP);
}

void loop() {
  Serial.println(analogRead(A0));
  delay(100);
}
