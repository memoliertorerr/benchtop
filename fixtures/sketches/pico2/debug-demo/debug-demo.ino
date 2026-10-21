// debug-demo — tests assert (BT71, the CPU debugger on the Pico 2's RISC-V hart 0):
// - addSlow is noinline and extern "C" (so its symbol is plain `addSlow`): a breakpoint on it
//   stops with its first argument a = seedA in a0 (1234 on the first call, then 1235, …).
// - counter (a uint16_t global) in SRAM equals what the sketch last printed.
// USB serial prints "a=<seedA> counter=<counter>" each loop, every 100 ms.
volatile int seedA = 1234, seedB = 4321;
volatile uint16_t counter;
volatile int result;

extern "C" __attribute__((noinline)) int addSlow(int a, int b) {
  int sum = 0;
  for (int i = 0; i < 8; i++) sum += (a ^ i) + (b >> i);
  return sum;
}

void setup() {
  Serial.begin(115200);
}

void loop() {
  result = addSlow(seedA, seedB);
  counter++; // DEBUG_MARK
  Serial.print("a=");
  Serial.print(seedA);
  Serial.print(" counter=");
  Serial.println(counter);
  seedA++;
  delay(100);
}
