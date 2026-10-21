// Pico 2 MIPS (BT65): a busy integer loop (a 32-bit LCG and a running sum) on the RP2350's RISC-V
// core, timed by micros(); "done <sum>" and the microseconds it took on UART0 (Serial1). The test
// reports the simulated MIPS from it.
void setup() {
  Serial1.begin(115200);
}

void loop() {
  uint32_t x = 1, sum = 0;
  uint32_t start = micros();
  for (int i = 0; i < 200000; i++) {
    x = x * 1664525u + 1013904223u;
    sum += x >> 16;
  }
  uint32_t took = micros() - start;
  Serial1.printf("done %lu in %lu us\n", (unsigned long)sum, (unsigned long)took);
  delay(100);
}
