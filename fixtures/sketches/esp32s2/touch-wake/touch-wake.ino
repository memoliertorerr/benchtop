// touch-wake (ESP32-S2) — tests assert (BT160): Arduino's TouchWakeUp example's shape. Counts its
// boots in RTC memory and prints "boot <n>: <cause>" at 115200 baud — "power-on", or "touch pad <t>"
// when a touch on T3 (GPIO3; a reading 5000 over its benchmark) woke it —, then arms the touch wake
// (touchSleepWakeUpEnable), prints "sleeping" and goes into deep sleep until the next touch.
RTC_DATA_ATTR int boots = 0;

void setup() {
  Serial.begin(115200);
  delay(100);
  boots++;
  if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_TOUCHPAD) {
    Serial.printf("boot %d: touch pad %d\n", boots, (int)esp_sleep_get_touchpad_wakeup_status());
  } else {
    Serial.printf("boot %d: power-on\n", boots);
  }
  touchSleepWakeUpEnable(T3, 5000);
  Serial.println("sleeping");
  Serial.flush();
  esp_deep_sleep_start();
}

void loop() {
}
