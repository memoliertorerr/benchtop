// timekeeping — tests assert (BT33): after "start us=<micros>", a line
// "t=<millis> us=<micros> isr=<count>" every 250 ms (vTaskDelay); millis() advances 250 ±1 per
// line, micros() tracks simulated time within ±0.1 %, and the hardware timer (timerBegin(0, 80,
// true): 1 MHz; 100 ms auto-reload alarm) fires exactly 10 times between lines 1 s apart.
// After the 8th line the CPU drops to 80 MHz ("cpu=80") and the lines keep the same timing (that
// one step is ~2.6 ms longer: setCpuFrequencyMhz waits for the UART to drain the previous line).
hw_timer_t *timer = nullptr;
volatile uint32_t isrCount = 0;
uint32_t lines = 0;

void IRAM_ATTR onTimer() {
  isrCount++;
}

void setup() {
  Serial.begin(115200);
  timer = timerBegin(0, 80, true);
  timerAttachInterrupt(timer, &onTimer, true);
  timerAlarmWrite(timer, 100000, true);
  timerAlarmEnable(timer);
  Serial.printf("start us=%lu\n", (unsigned long)micros());
}

void loop() {
  vTaskDelay(pdMS_TO_TICKS(250));
  Serial.printf("t=%lu us=%lu isr=%lu\n", (unsigned long)millis(), (unsigned long)micros(), (unsigned long)isrCount);
  if (++lines == 8) {
    setCpuFrequencyMhz(80);
    Serial.println("cpu=80");
  }
}
