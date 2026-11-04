// deep-sleep-pins — tests assert (BT121): deep sleep woken by a pin. ext0: GPIO33 (RTC GPIO 8)
// LOW — a button to GND, the RTC pull-up on; ext1: GPIO32 (RTC GPIO 9) HIGH (ANY_HIGH), the RTC
// pull-down on. Each start counts itself in RTC_DATA_ATTR and prints, at 115200 baud,
// "boot <n> cause <esp_sleep_get_wakeup_cause()> ext1 <esp_sleep_get_ext1_wakeup_status() hex>"
// (cause 2 EXT0, 3 EXT1), then enables both wakes and sleeps.
#include <esp_sleep.h>
#include <driver/rtc_io.h>

RTC_DATA_ATTR int boots = 0;

void setup() {
  Serial.begin(115200);
  boots++;
  Serial.printf("boot %d cause %d ext1 %llx\n", boots, (int)esp_sleep_get_wakeup_cause(), esp_sleep_get_ext1_wakeup_status());
  rtc_gpio_pullup_en(GPIO_NUM_33);
  rtc_gpio_pulldown_dis(GPIO_NUM_33);
  esp_sleep_enable_ext0_wakeup(GPIO_NUM_33, 0);
  rtc_gpio_pulldown_en(GPIO_NUM_32);
  rtc_gpio_pullup_dis(GPIO_NUM_32);
  esp_sleep_enable_ext1_wakeup(1ULL << 32, ESP_EXT1_WAKEUP_ANY_HIGH);
  Serial.flush();
  esp_deep_sleep_start();
}

void loop() {
}
