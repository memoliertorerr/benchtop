// checker-demo — tests assert: D2 is pinMode(INPUT) (no pull-up — floating while the button is open) and its digitalRead() is printed every
// 100 ms at 115200 baud; D7 is OUTPUT HIGH and D8 OUTPUT LOW all the time; D13 blinks (500 ms
// on, 500 ms off, starting HIGH). The circuit checker fixtures (problems-*.json) run it.
unsigned long nextPrint = 0;
unsigned long nextBlink = 0;
bool led = false;

void setup() {
  Serial.begin(115200);
  pinMode(2, INPUT);
  pinMode(7, OUTPUT);
  digitalWrite(7, HIGH);
  pinMode(8, OUTPUT);
  digitalWrite(8, LOW);
  pinMode(13, OUTPUT);
}

void loop() {
  unsigned long now = millis();
  if (now >= nextBlink) {
    nextBlink += 500;
    led = !led;
    digitalWrite(13, led ? HIGH : LOW);
  }
  if (now >= nextPrint) {
    nextPrint += 100;
    Serial.println(digitalRead(2));
  }
}
