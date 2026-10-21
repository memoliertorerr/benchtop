// distance-meter — tests assert (BT43): an HC-SR04 (TRIG on D9, ECHO on D10) measured five times
// a second; the distance in cm shown right-aligned on a 4-digit common-cathode 7-segment display
// (segments A..G on D2..D8 through 220 Ω, digits DIG1..DIG4 on A0..A3, active low, multiplexed
// 2 ms per digit). 100 cm shows " 100".
const uint8_t TRIG = 9;
const uint8_t ECHO = 10;
const uint8_t SEGMENTS[7] = {2, 3, 4, 5, 6, 7, 8};
const uint8_t DIGITS[4] = {A0, A1, A2, A3};
// Bits 0..6 = segments A..G for 0..9.
const uint8_t FONT[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};

unsigned int shown = 0;
unsigned long lastMeasure = 0;

unsigned int measureCm() {
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);  // a 10 µs pulse starts a measurement
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  unsigned long echo = pulseIn(ECHO, HIGH, 30000UL);  // µs; 0 when nothing came back
  return echo / 58;  // sound goes there and back: 58 µs per cm
}

// Lights digit `d` (0 = leftmost) with `value`'s digit, or blank.
void showDigit(uint8_t d, int digit) {
  uint8_t bits = digit < 0 ? 0 : FONT[digit];
  for (uint8_t s = 0; s < 7; s++) digitalWrite(SEGMENTS[s], (bits >> s) & 1);
  digitalWrite(DIGITS[d], LOW);
  delayMicroseconds(2000);
  digitalWrite(DIGITS[d], HIGH);
}

void setup() {
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  for (uint8_t s = 0; s < 7; s++) pinMode(SEGMENTS[s], OUTPUT);
  for (uint8_t d = 0; d < 4; d++) {
    pinMode(DIGITS[d], OUTPUT);
    digitalWrite(DIGITS[d], HIGH);
  }
}

void loop() {
  if (millis() - lastMeasure >= 200) {
    lastMeasure = millis();
    shown = min(measureCm(), 9999U);
  }
  unsigned int value = shown;
  for (int d = 3; d >= 0; d--) {
    // Leading zeros stay dark; a lone 0 still shows.
    bool blank = value == 0 && d < 3;
    showDigit(d, blank ? -1 : value % 10);
    value /= 10;
  }
}
