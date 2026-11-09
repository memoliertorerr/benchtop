// rc-delay — tests assert (BT167): pin 8 charges 10 kΩ into 100 nF to GND; pin 2 (an input) reads
// the capacitor. Each round: pin 8 HIGH, wait for pin 2 to read HIGH, print "rise <µs>"; 20 ms
// later pin 8 LOW, wait for LOW, print "fall <µs>". RC ≈ 1 ms: the input rises RC·ln(5/2) ≈ 0.92 ms
// after the edge (VIH 3 V) and falls RC·ln(5/1.5) ≈ 1.21 ms after it (VIL 1.5 V).
const int OUT = 8;
const int IN = 2;

void setup() {
  Serial.begin(115200);
  pinMode(OUT, OUTPUT);
  pinMode(IN, INPUT);
  digitalWrite(OUT, LOW);
  delay(20);
}

void loop() {
  digitalWrite(OUT, HIGH);
  uint32_t t0 = micros();
  while (digitalRead(IN) == LOW) {
  }
  uint32_t rise = micros() - t0;
  Serial.print("rise ");
  Serial.println(rise);
  delay(20);
  digitalWrite(OUT, LOW);
  t0 = micros();
  while (digitalRead(IN) == HIGH) {
  }
  uint32_t fall = micros() - t0;
  Serial.print("fall ");
  Serial.println(fall);
  delay(20);
}
