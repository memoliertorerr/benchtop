// cli-demo — tests assert (BT25, the headless runner):
// - UART0 at 115200 baud prints "boot" once at start.
// - D13 is (millis() / 1000) % 2: LOW during the first second, HIGH during the second, …
// - D2 is INPUT_PULLUP; each falling edge (the button to GND pressed) prints "pressed".
bool last = HIGH;

void setup() {
  Serial.begin(115200);
  Serial.println("boot");
  pinMode(13, OUTPUT);
  pinMode(2, INPUT_PULLUP);
}

void loop() {
  digitalWrite(13, (millis() / 1000) % 2);
  bool now = digitalRead(2);
  if (last == HIGH && now == LOW) Serial.println("pressed");
  last = now;
}
