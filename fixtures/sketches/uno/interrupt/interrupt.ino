// interrupt — tests assert: D2 (PD2, INT0) is INPUT_PULLUP and every falling edge increments a
// counter; UART0 at 115200 baud prints the count as a decimal line every 100 ms, so 5 falling
// edges give a printed count of 5.
volatile unsigned int count = 0;

void onFall() {
  count++;
}

void setup() {
  Serial.begin(115200);
  pinMode(2, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(2), onFall, FALLING);
}

void loop() {
  noInterrupts();
  unsigned int n = count;
  interrupts();
  Serial.println(n);
  delay(100);
}
