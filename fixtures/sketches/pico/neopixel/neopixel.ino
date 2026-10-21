// neopixel — tests assert (BT62): eight WS2812 pixels on GP2 driven by our own PIO program
// (ws2812.pio, assembled by arduino-pico's pioasm into ws2812.pio.h) on PIO0 at 800 kHz:
// pixel 0 cycles red → green → blue every 500 ms, pixels 1–7 show fixed colors; "shown <n>" on
// USB serial after each update.
#include <hardware/clocks.h>
#include <hardware/pio.h>
#include "ws2812.pio.h"

const uint PIN = 2;
PIO pio = pio0;
uint sm;

uint32_t grb(uint8_t r, uint8_t g, uint8_t b) {
  return ((uint32_t)g << 16) | ((uint32_t)r << 8) | b;
}

const uint32_t FIXED[7] = {grb(0, 255, 0), grb(0, 0, 255), grb(16, 16, 16), grb(255, 255, 0), grb(0, 255, 255), grb(255, 0, 255), grb(0, 0, 0)};

void setup() {
  Serial.begin(115200);
  uint offset = pio_add_program(pio, &ws2812_program);
  sm = pio_claim_unused_sm(pio, true);
  pio_gpio_init(pio, PIN);
  pio_sm_set_consecutive_pindirs(pio, sm, PIN, 1, true);
  pio_sm_config c = ws2812_program_get_default_config(offset);
  sm_config_set_sideset_pins(&c, PIN);
  sm_config_set_out_shift(&c, false, true, 24);  // MSB first, autopull every 24 bits
  sm_config_set_fifo_join(&c, PIO_FIFO_JOIN_TX);
  sm_config_set_clkdiv(&c, clock_get_hz(clk_sys) / (800000.0f * 10));  // 10 PIO cycles a bit
  pio_sm_init(pio, sm, offset, &c);
  pio_sm_set_enabled(pio, sm, true);
}

int n = 0;

void loop() {
  const uint32_t first = n % 3 == 0 ? grb(255, 0, 0) : n % 3 == 1 ? grb(0, 255, 0) : grb(0, 0, 255);
  pio_sm_put_blocking(pio, sm, first << 8u);
  for (int i = 0; i < 7; i++) pio_sm_put_blocking(pio, sm, FIXED[i] << 8u);
  Serial.print("shown ");
  Serial.println(n);
  n++;
  delay(500);
}
