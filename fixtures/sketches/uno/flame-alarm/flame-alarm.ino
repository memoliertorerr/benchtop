// flame-alarm — tests assert (BT53): a flame sensor module, DOUT on D2 (active low) and AOUT on
// A0. On each change of DOUT it prints "FLAME a0=<n>" or "clear a0=<n>" at 115200 baud; while a
// flame is seen a passive buzzer on D8 sounds 2 kHz and the L LED (D13) is on.
const uint8_t DOUT = 2, BUZZER = 8, LED = 13;
int last = -1;

void setup() {
  Serial.begin(115200);
  pinMode(DOUT, INPUT);
  pinMode(LED, OUTPUT);
}

void loop() {
  int flame = digitalRead(DOUT) == LOW;
  if (flame != last) {
    last = flame;
    Serial.print(flame ? "FLAME a0=" : "clear a0=");
    Serial.println(analogRead(A0));
    if (flame) tone(BUZZER, 2000);
    else noTone(BUZZER);
    digitalWrite(LED, flame);
  }
  delay(20);
}
