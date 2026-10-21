// parking — tests assert (BT56): a parking sensor. An HC-SR04 (TRIG D9, ECHO D10) measures ten
// times a second and prints "D=<cm>" at 115200 baud (0 = nothing within 4 m). The buzzer on D8
// beeps 2 kHz for 50 ms, more often the closer the car: every (distance × 8) ms below 1 m,
// continuously below 30 cm, when it also prints "STOP" once.
const uint8_t TRIG = 9, ECHO = 10, BUZZER = 8;
unsigned long lastBeep = 0;
bool stopped = false;

unsigned int measureCm() {
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  unsigned long us = pulseIn(ECHO, HIGH, 30000);
  return us == 0 ? 0 : (unsigned int)(us / 58);
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
}

void loop() {
  unsigned int cm = measureCm();
  Serial.print("D=");
  Serial.println(cm);
  if (cm > 0 && cm < 30) {
    tone(BUZZER, 2000);
    if (!stopped) Serial.println("STOP");
    stopped = true;
  } else {
    stopped = false;
    noTone(BUZZER);
    if (cm > 0 && cm < 100 && millis() - lastBeep >= cm * 8UL) {
      lastBeep = millis();
      tone(BUZZER, 2000, 50);
    }
  }
  delay(100);
}
