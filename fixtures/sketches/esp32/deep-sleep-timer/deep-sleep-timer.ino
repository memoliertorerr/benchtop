// deep-sleep-timer — tests assert (BT121): deep sleep woken by the RTC timer every 2 s. Each start
// counts itself in RTC slow memory (RTC_DATA_ATTR, kept through deep sleep) and prints, at 115200
// baud, "boot <n> cause <esp_sleep_get_wakeup_cause()> reset <esp_reset_reason()>" — boot 1 after
// power-on (cause 0 UNDEFINED, reset 1 POWERON), then boot 2, 3… 2 s apart (cause 4 TIMER, reset
// 8 DEEPSLEEP) — then enables the timer wake and sleeps.
#include <esp_sleep.h>

RTC_DATA_ATTR int boots = 0;

void setup() {
  Serial.begin(115200);
  boots++;
  Serial.printf("boot %d cause %d reset %d\n", boots, (int)esp_sleep_get_wakeup_cause(), (int)esp_reset_reason());
  esp_sleep_enable_timer_wakeup(2000000ULL);
  Serial.flush();
  esp_deep_sleep_start();
}

void loop() {
}
