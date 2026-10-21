// seven-seg-mux — tests assert: a 4-digit common-cathode 7-segment display multiplexed at
// ~120 Hz shows "1234". Segments A, B, C, D, E, F, G, DP on D2..D9 (through 220 ohm), digit
// commons DIG1..DIG4 on A0..A3 (active low). Each digit is lit for 2 ms in turn and every digit
// is off while the segments change, so a lit segment's brightness is ~0.25 and no segment of a
// digit ghosts into another.
const uint8_t SEGMENT_PINS[8] = {2, 3, 4, 5, 6, 7, 8, 9};
const uint8_t DIGIT_PINS[4] = {A0, A1, A2, A3};
// Bits 0..6 = segments A..G.
const uint8_t FONT[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};
const uint8_t SHOWN[4] = {1, 2, 3, 4};

void setup() {
  for (uint8_t i = 0; i < 8; i++) pinMode(SEGMENT_PINS[i], OUTPUT);
  for (uint8_t i = 0; i < 4; i++) {
    pinMode(DIGIT_PINS[i], OUTPUT);
    digitalWrite(DIGIT_PINS[i], HIGH);
  }
}

void loop() {
  for (uint8_t d = 0; d < 4; d++) {
    uint8_t bits = FONT[SHOWN[d]];
    for (uint8_t s = 0; s < 8; s++) digitalWrite(SEGMENT_PINS[s], (bits >> s) & 1);
    digitalWrite(DIGIT_PINS[d], LOW);
    delayMicroseconds(2000);
    digitalWrite(DIGIT_PINS[d], HIGH);
  }
}
