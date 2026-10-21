// restart-loop — tests assert (BT33): every boot prints "boot" on UART0 and restarts at once
// (ESP.restart() at the top of setup). After 5 rapid reboots the emulator stops the run with
// "reboot loop: SW_CPU_RESET …" — UART0 shows "boot" 6 times.
void setup() {
  Serial.begin(115200);
  Serial.println("boot");
  Serial.flush();
  ESP.restart();
}

void loop() {
}
