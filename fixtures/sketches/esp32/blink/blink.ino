// blink — tests assert: GPIO2 (the DevKit's on-board LED) is HIGH for 500 ms, then LOW for
// 500 ms, repeating. BT27 checks the image layout (5 segments: DROM, DRAM, IROM, DRAM, IRAM).
void setup() {
  pinMode(2, OUTPUT);
}

void loop() {
  digitalWrite(2, HIGH);
  delay(500);
  digitalWrite(2, LOW);
  delay(500);
}
