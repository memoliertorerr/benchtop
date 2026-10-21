// relay — tests assert: D7 drives a KS2E-M-DC5 relay coil (COIL1 on D7, COIL2 on GND) and
// toggles every 500 ms, starting HIGH; an LED with 220 ohm sits on NO1 (P1 on 5V). Each change
// prints "coil 1" or "coil 0" at 115200 baud, just before the pin changes.
void setup() {
  Serial.begin(115200);
  pinMode(7, OUTPUT);
}

void loop() {
  Serial.println(F("coil 1"));
  Serial.flush();
  digitalWrite(7, HIGH);
  delay(500);
  Serial.println(F("coil 0"));
  Serial.flush();
  digitalWrite(7, LOW);
  delay(500);
}
