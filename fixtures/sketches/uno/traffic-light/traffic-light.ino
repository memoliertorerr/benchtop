// traffic-light — tests assert (BT43): a traffic light on D10 (red), D9 (yellow) and D8 (green),
// each LED through 220 Ω: red 700 ms, red + yellow 300 ms, green 700 ms, yellow 300 ms, over and
// over — a 2 s cycle, much quicker than a real one so you can watch it.
const int RED = 10;
const int YELLOW = 9;
const int GREEN = 8;

// Shows one phase of the cycle for `ms` milliseconds.
void show(bool red, bool yellow, bool green, unsigned long ms) {
  digitalWrite(RED, red);
  digitalWrite(YELLOW, yellow);
  digitalWrite(GREEN, green);
  delay(ms);
}

void setup() {
  pinMode(RED, OUTPUT);
  pinMode(YELLOW, OUTPUT);
  pinMode(GREEN, OUTPUT);
}

void loop() {
  show(HIGH, LOW, LOW, 700);   // stop
  show(HIGH, HIGH, LOW, 300);  // get ready
  show(LOW, LOW, HIGH, 700);   // go
  show(LOW, HIGH, LOW, 300);   // stop soon
}
