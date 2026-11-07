// psram-quad — tests assert (BT130): built with the board menu's PSRAM "QSPI PSRAM" (the
// ESP32-S3-WROOM-1 N8R2's 2 MB quad PSRAM, which Arduino's psramInit starts). Prints, at 115200
// baud, "psram found <0|1> size <ESP.getPsramSize()> free <ESP.getFreePsram()>", then fills a
// 1 MB ps_malloc buffer with a pattern, reads it back and prints "check <ok|bad> sum <hex>", and
// "big <0|1>" for whether a 256 KB malloc (above CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL) landed in
// PSRAM (0x3C000000–0x3DFFFFFF data bus).
void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.printf("psram found %d size %u free %u\n", psramFound() ? 1 : 0, ESP.getPsramSize(), ESP.getFreePsram());
  const size_t n = 1024 * 1024;
  uint32_t *buf = (uint32_t *)ps_malloc(n);
  if (buf == nullptr) {
    Serial.println("check bad sum 0");
  } else {
    for (size_t i = 0; i < n / 4; i++) buf[i] = (uint32_t)(i * 2654435761u);
    uint32_t sum = 0;
    bool ok = true;
    for (size_t i = 0; i < n / 4; i++) {
      if (buf[i] != (uint32_t)(i * 2654435761u)) ok = false;
      sum += buf[i];
    }
    Serial.printf("check %s sum %08x\n", ok ? "ok" : "bad", (unsigned)sum);
  }
  void *big = malloc(256 * 1024);
  uintptr_t a = (uintptr_t)big;
  Serial.printf("big %d\n", (a >= 0x3C000000 && a < 0x3E000000) ? 1 : 0);
  Serial.println("done");
}

void loop() {
  delay(1000);
}
