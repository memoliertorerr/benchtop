// wdt-trip — tests assert (BT33): "start" on UART0; 1 s later a 1 s busy loop with interrupts
// disabled on this core trips the interrupt watchdog (300 ms): the panic handler prints
// "Guru Meditation Error" and "Interrupt wdt timeout", the chip reboots, and "start" appears a
// second time. The cycle takes ~1.5 s — slower than the rapid-reboot guard's 1 s (the delay is
// there for that), so it keeps running, as a real board would.
void setup() {
  Serial.begin(115200);
  Serial.println("start");
  delay(1000);
  portDISABLE_INTERRUPTS();
  int64_t t0 = esp_timer_get_time();
  while (esp_timer_get_time() - t0 < 1000000) {
  }
  portENABLE_INTERRUPTS();
  Serial.println("survived");
}

void loop() {
  delay(1000);
}
