// light-sleep — tests assert (BT122): light sleep keeps everything. A counter in plain RAM counts
// ten 100 ms timer sleeps (esp_sleep_enable_timer_wakeup + esp_light_sleep_start), printing
// "wake <n> cause <esp_sleep_get_wakeup_cause()> millis <millis()>" after each at 115200 baud —
// cause 4 (TIMER), millis ≈ 100 ms further each time (the sleep counted once). Then it sleeps until
// the button on D4 (GPIO4, to GND, INPUT_PULLUP) is pressed — gpio_wakeup_enable(GPIO_NUM_4,
// GPIO_INTR_LOW_LEVEL) and esp_sleep_enable_gpio_wakeup() — and prints "gpio wake cause <c>"
// (7 GPIO).
#include <esp_sleep.h>
#include <driver/gpio.h>

int wakes = 0;

void setup() {
  Serial.begin(115200);
  pinMode(4, INPUT_PULLUP);
  Serial.printf("start millis %lu\n", millis());
  for (int i = 0; i < 10; i++) {
    esp_sleep_enable_timer_wakeup(100000);
    Serial.flush();
    esp_light_sleep_start();
    wakes++;
    Serial.printf("wake %d cause %d millis %lu\n", wakes, (int)esp_sleep_get_wakeup_cause(), millis());
  }
  esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_TIMER);
  gpio_wakeup_enable(GPIO_NUM_4, GPIO_INTR_LOW_LEVEL);
  esp_sleep_enable_gpio_wakeup();
  Serial.flush();
  esp_light_sleep_start();
  Serial.printf("gpio wake cause %d\n", (int)esp_sleep_get_wakeup_cause());
}

void loop() {
  delay(100);
}
