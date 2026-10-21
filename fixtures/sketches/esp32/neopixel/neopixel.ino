// neopixel — tests assert: every 500 ms loop() prints "color N" (N = 0, 1, 2, 3, 0, …) on UART0
// at 115200 baud, then neopixelWrite(4, r, g, b) sends color N — red (255, 0, 0), green
// (0, 255, 0), blue (0, 0, 255), dim white (32, 32, 32) — through the RMT (core 2.0.17's
// esp32-hal-rgb-led.c: 100 ns ticks, a 0 bit 4 + 8 ticks, a 1 bit 8 + 4, GRB order).
static const uint8_t COLORS[4][3] = {{255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {32, 32, 32}};
static int n = 0;

void setup() {
  Serial.begin(115200);
}

void loop() {
  const uint8_t *c = COLORS[n % 4];
  Serial.printf("color %d\n", n % 4);
  neopixelWrite(4, c[0], c[1], c[2]);
  n++;
  delay(500);
}
