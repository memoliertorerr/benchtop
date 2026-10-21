// buzzer — tests assert: a passive buzzer on D8 plays tone(8, 440) for 500 ms, then
// tone(8, 880) for 500 ms, then noTone(8); 100 ms later an active buzzer on D7 gets D7 HIGH for
// 200 ms, then LOW. Each change is announced first at 115200 baud: "440", "880", "off",
// "active on", "active off".
void setup() {
  Serial.begin(115200);
  pinMode(7, OUTPUT);
  Serial.println(F("440"));
  tone(8, 440);
  delay(500);
  Serial.println(F("880"));
  tone(8, 880);
  delay(500);
  Serial.println(F("off"));
  noTone(8);
  delay(100);
  Serial.println(F("active on"));
  digitalWrite(7, HIGH);
  delay(200);
  Serial.println(F("active off"));
  digitalWrite(7, LOW);
}

void loop() {
}
