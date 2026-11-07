// ledc-duty-step — tests assert (BT131): two 5 kHz, 10-bit LEDC channels — channel 0 (the
// high-speed group) on GPIO18 and channel 8 (the low-speed group, whose duty change ESP-IDF latches
// with CONF0's PARA_UP after DUTY_START) on GPIO19 — step their duties through 25 %, 50 % and 75 %
// every 1.7 ms (8.5 periods, so a change lands mid-pulse half the time). Every period must be
// there, each pulse one of the three duties, a new duty starting at a period boundary. Prints
// "ready" once both run.
const uint32_t DUTIES[] = {256, 512, 768};

void setup() {
  Serial.begin(115200);
  ledcSetup(0, 5000, 10);
  ledcAttachPin(18, 0);
  ledcSetup(8, 5000, 10);
  ledcAttachPin(19, 8);
  ledcWrite(0, DUTIES[0]);
  ledcWrite(8, DUTIES[1]);
  Serial.println("ready");
}

void loop() {
  static int i = 0;
  i++;
  ledcWrite(0, DUTIES[i % 3]);
  ledcWrite(8, DUTIES[(i + 1) % 3]);
  delayMicroseconds(1700);
}
