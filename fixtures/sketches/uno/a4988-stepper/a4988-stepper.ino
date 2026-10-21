// a4988-stepper — tests assert (BT53): an A4988 (STEP D3, DIR D4, MS1–MS3 D5–D7) driving a
// 200-step bipolar motor. Full steps (MS 000), DIR high: 200 pulses, 1 ms apart — one turn
// forward — then "full" at 115200 baud; then sixteenth steps (MS 111), DIR low: 3,200 pulses,
// 250 µs apart — one turn back — then "sixteenth".
const uint8_t STEP = 3, DIR = 4, MS1 = 5, MS2 = 6, MS3 = 7;

void pulses(uint16_t count, uint16_t periodUs) {
  for (uint16_t i = 0; i < count; i++) {
    digitalWrite(STEP, HIGH);
    delayMicroseconds(periodUs / 2);
    digitalWrite(STEP, LOW);
    delayMicroseconds(periodUs / 2);
  }
}

void setup() {
  Serial.begin(115200);
  for (uint8_t pin = STEP; pin <= MS3; pin++) pinMode(pin, OUTPUT);
  delay(10);
  digitalWrite(DIR, HIGH);
  pulses(200, 1000);
  Serial.println("full");
  digitalWrite(MS1, HIGH);
  digitalWrite(MS2, HIGH);
  digitalWrite(MS3, HIGH);
  digitalWrite(DIR, LOW);
  pulses(3200, 250);
  Serial.println("sixteenth");
}

void loop() {}
