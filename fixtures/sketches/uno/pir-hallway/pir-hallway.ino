// pir-hallway — tests assert (BT56): a PIR (OUT on D2) watches a hallway; while it reports
// motion the lamp on D8 and the L LED (D13) are on. Each change prints "motion: light on" or
// "clear: light off" at 115200 baud; "hallway ready" at start.
const uint8_t PIR = 2, LAMP = 8, LED = 13;
bool on = false;

void setup() {
  Serial.begin(115200);
  pinMode(PIR, INPUT);
  pinMode(LAMP, OUTPUT);
  pinMode(LED, OUTPUT);
  Serial.println("hallway ready");
}

void loop() {
  bool motion = digitalRead(PIR) == HIGH;
  if (motion == on) return;
  on = motion;
  digitalWrite(LAMP, on);
  digitalWrite(LED, on);
  Serial.println(on ? "motion: light on" : "clear: light off");
}
