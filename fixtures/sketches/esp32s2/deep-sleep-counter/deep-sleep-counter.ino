// deep-sleep-counter (ESP32-S2, BT152: the ESP32's sketch) — the gallery's deep sleep example
// (BT123): a board that spends its time in deep sleep, woken every 5 s by its RTC timer or at once
// by the button on GPIO4 (RTC GPIO 4 on the S2, to GND; ext0 on LOW with the RTC pull-up on). Wakes and presses are counted in RTC memory
// (RTC_DATA_ATTR: kept through deep sleep, cleared by a power-on or the Reset button). Each wake
// prints "boot <n>: <power-on|timer|button>, <p> presses" at 115200 baud and flashes the LED on GPIO2
// (once for the timer, twice for the button); a button still held is waited out, so one press is
// one wake.
#include <esp_sleep.h>
#include <driver/rtc_io.h>

const int LED = 2;
const gpio_num_t BUTTON = GPIO_NUM_4;
RTC_DATA_ATTR int boots = 0;
RTC_DATA_ATTR int presses = 0;

void flash(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED, HIGH);
    delay(150);
    digitalWrite(LED, LOW);
    delay(150);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
  boots++;
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
  bool button = cause == ESP_SLEEP_WAKEUP_EXT0;
  if (button) presses++;
  Serial.printf("boot %d: %s, %d presses\n", boots, button ? "button" : cause == ESP_SLEEP_WAKEUP_TIMER ? "timer" : "power-on", presses);
  flash(button ? 2 : 1);
  // The wake pin back to the GPIO matrix, to wait for the release.
  rtc_gpio_deinit(BUTTON);
  pinMode(BUTTON, INPUT_PULLUP);
  while (digitalRead(BUTTON) == LOW) delay(10);
  esp_sleep_enable_timer_wakeup(5000000ULL);
  rtc_gpio_pullup_en(BUTTON);
  rtc_gpio_pulldown_dis(BUTTON);
  esp_sleep_enable_ext0_wakeup(BUTTON, 0);
  Serial.flush();
  esp_deep_sleep_start();
}

void loop() {
}
