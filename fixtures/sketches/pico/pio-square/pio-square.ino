// pio-square — tests assert (BT62): our square.pio program on GP3 from PIO1, its clock divider
// set for 10 kHz (64 PIO cycles a period: clk_sys / (10 kHz × 64)); "square on GP3" on USB
// serial once a second.
#include <hardware/clocks.h>
#include <hardware/pio.h>
#include "square.pio.h"

const uint PIN = 3;

void setup() {
  Serial.begin(115200);
  PIO pio = pio1;
  uint offset = pio_add_program(pio, &square_program);
  uint sm = pio_claim_unused_sm(pio, true);
  pio_gpio_init(pio, PIN);
  pio_sm_set_consecutive_pindirs(pio, sm, PIN, 1, true);
  pio_sm_config c = square_program_get_default_config(offset);
  sm_config_set_set_pins(&c, PIN, 1);
  sm_config_set_clkdiv(&c, clock_get_hz(clk_sys) / (10000.0f * 64));
  pio_sm_init(pio, sm, offset, &c);
  pio_sm_set_enabled(pio, sm, true);
}

void loop() {
  Serial.println("square on GP3");
  delay(1000);
}
