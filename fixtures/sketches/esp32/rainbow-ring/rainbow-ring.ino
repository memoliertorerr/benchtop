// rainbow-ring — tests assert (BT43): a 16-pixel NeoPixel ring on GPIO18 shows a turning rainbow:
// pixel i gets hue i·16 + step (a 256-step color wheel) at a third of full brightness, a new
// frame every 50 ms. The bits go out through the RMT peripheral at 100 ns per tick: a 1 is
// 0.8 µs high then 0.4 µs low, a 0 is 0.4 µs high then 0.8 µs low; WS2812 order green, red, blue.
const int PIN = 18;
const int PIXELS = 16;

rmt_obj_t *rmt;
rmt_data_t bits[PIXELS * 24];

// A hue 0..255 on the color wheel → red, green, blue.
void wheel(uint8_t hue, uint8_t &r, uint8_t &g, uint8_t &b) {
  if (hue < 85) {
    r = 255 - hue * 3; g = hue * 3; b = 0;
  } else if (hue < 170) {
    hue -= 85;
    r = 0; g = 255 - hue * 3; b = hue * 3;
  } else {
    hue -= 170;
    r = hue * 3; g = 0; b = 255 - hue * 3;
  }
}

// Eight RMT items for one byte, most significant bit first.
void setByte(int at, uint8_t value) {
  for (int bit = 0; bit < 8; bit++) {
    bool one = value & (0x80 >> bit);
    bits[at + bit].level0 = 1;
    bits[at + bit].duration0 = one ? 8 : 4;
    bits[at + bit].level1 = 0;
    bits[at + bit].duration1 = one ? 4 : 8;
  }
}

void setup() {
  rmt = rmtInit(PIN, RMT_TX_MODE, RMT_MEM_64);
  rmtSetTick(rmt, 100);  // ns per tick
}

void loop() {
  static uint8_t step = 0;
  for (int i = 0; i < PIXELS; i++) {
    uint8_t r, g, b;
    wheel(i * 16 + step, r, g, b);
    setByte(i * 24, g / 3);
    setByte(i * 24 + 8, r / 3);
    setByte(i * 24 + 16, b / 3);
  }
  rmtWriteBlocking(rmt, bits, PIXELS * 24);
  step += 4;
  delay(50);  // also the >50 µs low that latches the colors
}
