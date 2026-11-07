// rgb-blink — tests assert (BT125): the DevKitC-1's RGB LED (a WS2812 on GPIO48) through the RMT.
// Every 500 ms loop() prints "step N" (N = 0…4, then again) on UART0 and shows: 0 red
// (255, 0, 0), 1 green (0, 255, 0), 2 blue (0, 0, 255) with neopixelWrite(RGB_BUILTIN, …); 3
// digitalWrite(LED_BUILTIN, HIGH) — the core lights it white at RGB_BRIGHTNESS (64, 64, 64); 4
// digitalWrite(LED_BUILTIN, LOW) — off (0, 0, 0). Bits as core 2.0.17's esp32-hal-rgb-led.c
// sends them: 100 ns RMT ticks, a 0 bit 4 + 8 ticks, a 1 bit 8 + 4, GRB order.
static int n = 0;

void setup() {
  Serial.begin(115200);
}

void loop() {
  int step = n % 5;
  Serial.printf("step %d\n", step);
  if (step == 0) neopixelWrite(RGB_BUILTIN, 255, 0, 0);
  else if (step == 1) neopixelWrite(RGB_BUILTIN, 0, 255, 0);
  else if (step == 2) neopixelWrite(RGB_BUILTIN, 0, 0, 255);
  else digitalWrite(LED_BUILTIN, step == 3 ? HIGH : LOW);
  n++;
  delay(500);
}
