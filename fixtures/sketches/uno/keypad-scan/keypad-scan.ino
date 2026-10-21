// keypad-scan — tests assert: a 4x4 matrix keypad ("123A/456B/789C/*0#D") scanned the way the
// Keypad library does it (that library isn't installed): rows R1..R4 on D9..D6, columns C1..C4
// on D5..D2 with INPUT_PULLUP. Each scan drives one row OUTPUT LOW, leaves the other rows INPUT
// (high impedance) and reads the columns; a column at 0 means that key is down. Every 5 ms all
// 16 keys are scanned; each key that went from up to down prints its label on its own line at
// 115200 baud.
const uint8_t ROWS[4] = {9, 8, 7, 6};
const uint8_t COLS[4] = {5, 4, 3, 2};
const char KEYS[4][4] = {{'1', '2', '3', 'A'}, {'4', '5', '6', 'B'}, {'7', '8', '9', 'C'}, {'*', '0', '#', 'D'}};
bool down[4][4];

void setup() {
  Serial.begin(115200);
  for (uint8_t c = 0; c < 4; c++) pinMode(COLS[c], INPUT_PULLUP);
  for (uint8_t r = 0; r < 4; r++) pinMode(ROWS[r], INPUT);
}

void loop() {
  for (uint8_t r = 0; r < 4; r++) {
    pinMode(ROWS[r], OUTPUT);
    digitalWrite(ROWS[r], LOW);
    delayMicroseconds(10);
    for (uint8_t c = 0; c < 4; c++) {
      bool now = digitalRead(COLS[c]) == LOW;
      if (now && !down[r][c]) Serial.println(KEYS[r][c]);
      down[r][c] = now;
    }
    pinMode(ROWS[r], INPUT);
  }
  delay(5);
}
