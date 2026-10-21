// simon — tests assert (BT43): "Simon says". Four buttons on D2..D5 (to GND, INPUT_PULLUP), four
// LEDs on D8..D11 (through 220 Ω) and a passive buzzer on D12. Each round the Uno adds a random
// step and plays the whole sequence, each step a LED with its own tone; repeat it with the
// buttons. A mistake plays a low tone and starts over. "round <n>" is printed (115200 baud) as
// each round starts, "game over" after a mistake.
const uint8_t BUTTONS[4] = {2, 3, 4, 5};
const uint8_t LEDS[4] = {8, 9, 10, 11};
const unsigned int TONES[4] = {330, 392, 494, 587};
const uint8_t BUZZER = 12;
const uint8_t MAX_STEPS = 32;

uint8_t steps[MAX_STEPS];
uint8_t count = 0;

// Lights LED `i` and plays its tone for `ms` milliseconds.
void flash(uint8_t i, unsigned int ms) {
  digitalWrite(LEDS[i], HIGH);
  tone(BUZZER, TONES[i]);
  delay(ms);
  digitalWrite(LEDS[i], LOW);
  noTone(BUZZER);
}

// Waits for a button to be pressed and released; returns which one.
uint8_t waitForButton() {
  while (true) {
    for (uint8_t i = 0; i < 4; i++) {
      if (digitalRead(BUTTONS[i]) == LOW) {
        flash(i, 200);
        while (digitalRead(BUTTONS[i]) == LOW) {
        }
        delay(20);  // let the contact settle (debounce)
        return i;
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < 4; i++) {
    pinMode(BUTTONS[i], INPUT_PULLUP);
    pinMode(LEDS[i], OUTPUT);
  }
  randomSeed(analogRead(A0));  // an unconnected pin gives a little noise on real boards
}

void loop() {
  if (count == MAX_STEPS) count = 0;
  steps[count++] = random(4);
  Serial.print("round ");
  Serial.println(count);
  delay(500);
  for (uint8_t i = 0; i < count; i++) {
    flash(steps[i], 400);
    delay(150);
  }
  for (uint8_t i = 0; i < count; i++) {
    if (waitForButton() != steps[i]) {
      Serial.println("game over");
      tone(BUZZER, 110, 800);
      delay(1000);
      count = 0;
      return;
    }
  }
  delay(300);
}
