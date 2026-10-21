// gas-fan — tests assert (BT56): an MQ-2 module (AOUT on A0) in a room with a gas leak. Above the
// alarm level (A0 > 400, about 200 ppm) the extractor fan on D7 runs and the buzzer on D8 sounds
// 2 kHz; the fan keeps running until A0 falls below 250 (about 50 ppm), then stops. Every 250 ms
// it prints "a0=<n> fan=<0|1>" at 115200 baud.
const uint8_t FAN = 7, BUZZER = 8;
const int ALARM = 400, CLEAR = 250;
bool fan = false;

void setup() {
  Serial.begin(115200);
  pinMode(FAN, OUTPUT);
}

void loop() {
  int a0 = analogRead(A0);
  if (!fan && a0 > ALARM) fan = true;
  else if (fan && a0 < CLEAR) fan = false;
  digitalWrite(FAN, fan);
  if (a0 > ALARM) tone(BUZZER, 2000);
  else noTone(BUZZER);
  Serial.print("a0=");
  Serial.print(a0);
  Serial.print(" fan=");
  Serial.println(fan);
  delay(250);
}
