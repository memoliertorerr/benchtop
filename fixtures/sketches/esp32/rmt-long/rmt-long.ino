// rmt-long — tests assert: rmtInit(18, RMT_TX_MODE, RMT_MEM_64) with rmtSetTick(100 ns), then
// rmtWriteBlocking of 150 items, each 1 µs high and 2 µs low (10 and 20 ticks) — more than the
// channel's 64-item block, so IDF's driver refills it from the TX threshold interrupt while the
// transmitter wraps — and "first" on UART0 at 115200 baud; after delay(1), 150 items whose high
// time is 10 + i % 10 ticks (low 20 ticks, so the order shows), then "second".
static rmt_data_t items[150];

void setup() {
  Serial.begin(115200);
  rmt_obj_t *rmt = rmtInit(18, RMT_TX_MODE, RMT_MEM_64);
  rmtSetTick(rmt, 100);
  for (int i = 0; i < 150; i++) {
    items[i].level0 = 1;
    items[i].duration0 = 10;
    items[i].level1 = 0;
    items[i].duration1 = 20;
  }
  rmtWriteBlocking(rmt, items, 150);
  Serial.println("first");
  delay(1);
  for (int i = 0; i < 150; i++) items[i].duration0 = 10 + i % 10;
  rmtWriteBlocking(rmt, items, 150);
  Serial.println("second");
}

void loop() {
  delay(1000);
}
