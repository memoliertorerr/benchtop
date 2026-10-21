// gas-meter — tests assert (BT53): an MQ-2 gas sensor module, AOUT on A0 and DOUT on D2 (active
// low). Every 250 ms it prints "a0=<n> alarm=<0|1>" at 115200 baud; the L LED (D13) shows the
// alarm.
const uint8_t DOUT = 2, LED = 13;

void setup() {
  Serial.begin(115200);
  pinMode(DOUT, INPUT);
  pinMode(LED, OUTPUT);
}

void loop() {
  int alarm = digitalRead(DOUT) == LOW;
  digitalWrite(LED, alarm);
  Serial.print("a0=");
  Serial.print(analogRead(A0));
  Serial.print(" alarm=");
  Serial.println(alarm);
  delay(250);
}
