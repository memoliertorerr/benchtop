// mega/chaser — tests assert: ten LEDs (a bar graph whose common cathodes share one 220 Ω to GND,
// fine because one LED is lit at a time) on the odd pins D23–D41 light one at a time, D23 first,
// moving every 100 ms up to D41 and back down.
const uint8_t PINS[] = {23, 25, 27, 29, 31, 33, 35, 37, 39, 41};

void step(uint8_t i) {
  digitalWrite(PINS[i], HIGH);
  delay(100);
  digitalWrite(PINS[i], LOW);
}

void setup() {
  for (uint8_t i = 0; i < 10; i++) pinMode(PINS[i], OUTPUT);
}

void loop() {
  for (uint8_t i = 0; i < 10; i++) step(i);
  for (uint8_t i = 8; i > 0; i--) step(i);
}
