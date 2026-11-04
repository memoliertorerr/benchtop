// deep-sleep — tests assert (BT122): the ESP32-C3's deep sleep, woken by the RTC timer every 2 s or
// by GPIO4 going low (a button to GND, pulled up; esp_deep_sleep_enable_gpio_wakeup — GPIO0–5 can
// wake it). Each start counts itself in RTC memory (RTC_DATA_ATTR, kept through deep sleep) and
// prints, at 115200 baud on UART0, "boot <n> cause <esp_sleep_get_wakeup_cause()> reset
// <esp_reset_reason()> pins <esp_sleep_get_gpio_wakeup_status()>" — boot 1 after power-on (cause
// 0, reset 1 POWERON), then cause 4 (TIMER) or 7 (GPIO, pins 16: GPIO4), reset 8 DEEPSLEEP. While
// the button is held it waits for the release before sleeping again.
#include <esp_sleep.h>

RTC_DATA_ATTR int boots = 0;

void setup() {
  Serial.begin(115200);
  pinMode(4, INPUT_PULLUP);
  boots++;
  Serial.printf("boot %d cause %d reset %d pins %llu\n", boots, (int)esp_sleep_get_wakeup_cause(), (int)esp_reset_reason(), (unsigned long long)esp_sleep_get_gpio_wakeup_status());
  while (digitalRead(4) == LOW) delay(10);
  esp_sleep_enable_timer_wakeup(2000000ULL);
  esp_deep_sleep_enable_gpio_wakeup(BIT(4), ESP_GPIO_WAKEUP_GPIO_LOW);
  Serial.flush();
  esp_deep_sleep_start();
}

void loop() {
}
