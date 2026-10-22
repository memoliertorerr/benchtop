// Pico multicore (BT82) — tests assert: both cores run. Core 0 (setup/loop) blinks the onboard
// LED (GP25) every 500 ms; core 1 (setup1/loop1) blinks GP15 every 250 ms. Once USB serial is up,
// core 0 prints "core0 on 0", tells core 1 to go through the inter-core FIFO (rp2040.fifo), core 1
// answers with its core number ("core1 on 1"), then core 0 sends 1, 2, 3 and core 1 returns each
// times 10 ("fifo 1 -> 10", …).
void setup() {
  Serial.begin(115200);
  while (!Serial) delay(10);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.printf("core0 on %d\r\n", (int)get_core_num());
  rp2040.fifo.push(0);  // go
  Serial.printf("core1 on %lu\r\n", (unsigned long)rp2040.fifo.pop());
  for (uint32_t i = 1; i <= 3; i++) {
    rp2040.fifo.push(i);
    Serial.printf("fifo %lu -> %lu\r\n", (unsigned long)i, (unsigned long)rp2040.fifo.pop());
  }
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}

void setup1() {
  pinMode(15, OUTPUT);
  rp2040.fifo.pop();  // core 0's go
  rp2040.fifo.push(get_core_num());
  for (int i = 0; i < 3; i++) rp2040.fifo.push(rp2040.fifo.pop() * 10);
}

void loop1() {
  digitalWrite(15, HIGH);
  delay(250);
  digitalWrite(15, LOW);
  delay(250);
}
