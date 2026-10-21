// hcsr04 — tests assert: every 100 ms a 10 us trigger on D9, then pulseIn(D10, HIGH, 30000) and
// "D=<cm, 1 decimal>" at 115200 baud, cm = microseconds * 0.01715 (343 m/s, there and back);
// a timeout (no echo end within 30 ms) prints "D=0.0". pulseIn runs with interrupts off: its
// counting loop stops while Timer0's millis() interrupt runs (~6 us every 1.024 ms), which would
// read ~0.6 % short (on real hardware too).
const uint8_t TRIG = 9;
const uint8_t ECHO = 10;

void setup() {
  Serial.begin(115200);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
}

void loop() {
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  noInterrupts();
  unsigned long us = pulseIn(ECHO, HIGH, 30000UL);
  interrupts();
  Serial.print(F("D="));
  Serial.println(us * 0.01715, 1);
  delay(100);
}
