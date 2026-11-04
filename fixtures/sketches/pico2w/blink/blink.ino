// Pico 2 W blink (BT113, the Pico W's sketch): the onboard LED sits on the CYW43439 WiFi chip's WL_GPIO0, so
// digitalWrite(LED_BUILTIN) goes through the chip's driver (cyw43_gpio_set). It toggles every
// 500 ms, printing "led 1" / "led 0" on Serial (USB) each time.
void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("led 1");
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("led 0");
  delay(500);
}
