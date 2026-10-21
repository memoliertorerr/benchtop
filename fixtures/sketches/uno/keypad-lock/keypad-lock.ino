// keypad-lock — tests assert (BT43): a code lock. A 4x4 keypad (rows R1..R4 on D9..D6, columns
// C1..C4 on D5..D2, scanned like keypad-scan), a servo latch on D10 and a buzzer on D11. Type
// 1 2 3 4 and # : the servo turns to 90° ("unlocked", a high beep) and closes again after 3 s
// ("locked"). A wrong code beeps low ("wrong"); * clears what was typed. Messages at 115200 baud.
#include <Servo.h>

const uint8_t ROWS[4] = {9, 8, 7, 6};
const uint8_t COLS[4] = {5, 4, 3, 2};
const char KEYS[4][4] = {{'1', '2', '3', 'A'}, {'4', '5', '6', 'B'}, {'7', '8', '9', 'C'}, {'*', '0', '#', 'D'}};
const char CODE[] = "1234";
const uint8_t BUZZER = 11;

Servo latch;
bool down[4][4];
char typed[8];
uint8_t length = 0;

// Returns the key that went down since the last scan, or 0.
char scanKeypad() {
  char pressed = 0;
  for (uint8_t r = 0; r < 4; r++) {
    pinMode(ROWS[r], OUTPUT);
    digitalWrite(ROWS[r], LOW);
    delayMicroseconds(10);
    for (uint8_t c = 0; c < 4; c++) {
      bool now = digitalRead(COLS[c]) == LOW;
      if (now && !down[r][c]) pressed = KEYS[r][c];
      down[r][c] = now;
    }
    pinMode(ROWS[r], INPUT);
  }
  return pressed;
}

void setup() {
  Serial.begin(115200);
  for (uint8_t c = 0; c < 4; c++) pinMode(COLS[c], INPUT_PULLUP);
  for (uint8_t r = 0; r < 4; r++) pinMode(ROWS[r], INPUT);
  latch.attach(10);
  latch.write(0);
  Serial.println("locked");
}

void loop() {
  char key = scanKeypad();
  if (key == '*') {
    length = 0;
  } else if (key == '#') {
    typed[length] = '\0';
    if (strcmp(typed, CODE) == 0) {
      Serial.println("unlocked");
      tone(BUZZER, 1760, 150);
      latch.write(90);
      delay(3000);
      latch.write(0);
      Serial.println("locked");
    } else {
      Serial.println("wrong");
      tone(BUZZER, 220, 400);
    }
    length = 0;
  } else if (key != 0 && length < sizeof typed - 1) {
    typed[length++] = key;
    tone(BUZZER, 880, 40);  // a click per key
  }
  delay(5);
}
