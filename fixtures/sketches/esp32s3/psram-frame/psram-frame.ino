// psram-frame — the gallery's PSRAM example (BT132): an ESP32-S3 with 8 MB of octal PSRAM (the
// board menu's "OPI PSRAM" — the `benchtop: psram` line below asks Benchtop's compile for it)
// keeps a whole 240×320 frame (150 KB) in PSRAM, redraws it every frame — three color bands and a
// white square sliding across — and pushes it to an ILI9341 in one go over SPI (SCK GPIO12, MOSI
// GPIO11, CS GPIO10, D/C GPIO9, RST GPIO14, 40 MHz). Prints "frame buffer <bytes> in psram <0|1>"
// once, then "frame <n>" for every frame.
// benchtop: psram
#include <SPI.h>

const uint8_t TFT_CS = 10, TFT_DC = 9, TFT_RST = 14;
const int W = 240, H = 320;
// Colors with their bytes swapped: the panel takes each pixel high byte first.
const uint16_t RED = 0x00F8, GREEN = 0xE007, BLUE = 0x1F00, WHITE = 0xFFFF, BLACK = 0x0000;

uint16_t *fb;

void command(uint8_t c) {
  digitalWrite(TFT_DC, LOW);
  digitalWrite(TFT_CS, LOW);
  SPI.transfer(c);
  digitalWrite(TFT_CS, HIGH);
}

void data(const uint8_t *bytes, size_t n) {
  digitalWrite(TFT_DC, HIGH);
  digitalWrite(TFT_CS, LOW);
  SPI.writeBytes(bytes, n);
  digitalWrite(TFT_CS, HIGH);
}

void window(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1) {
  uint8_t col[] = {(uint8_t)(x0 >> 8), (uint8_t)x0, (uint8_t)(x1 >> 8), (uint8_t)x1};
  uint8_t row[] = {(uint8_t)(y0 >> 8), (uint8_t)y0, (uint8_t)(y1 >> 8), (uint8_t)y1};
  command(0x2A);
  data(col, 4);
  command(0x2B);
  data(row, 4);
}

void draw(int n) {
  for (int y = 0; y < H; y++) {
    uint16_t band = y < 100 ? RED : y < 200 ? GREEN : y < 300 ? BLUE : BLACK;
    uint16_t *line = fb + y * W;
    for (int x = 0; x < W; x++) line[x] = band;
  }
  int sx = (n * 20) % (W - 40);
  for (int y = 140; y < 180; y++)
    for (int x = sx; x < sx + 40; x++) fb[y * W + x] = WHITE;
}

void setup() {
  Serial.begin(115200);
  pinMode(TFT_CS, OUTPUT);
  pinMode(TFT_DC, OUTPUT);
  pinMode(TFT_RST, OUTPUT);
  digitalWrite(TFT_CS, HIGH);
  SPI.begin();
  SPI.beginTransaction(SPISettings(40000000, MSBFIRST, SPI_MODE0));
  digitalWrite(TFT_RST, LOW);
  delay(10);
  digitalWrite(TFT_RST, HIGH);
  delay(10);
  command(0x01); // SWRESET
  delay(120);
  command(0x11); // SLPOUT
  delay(120);
  uint8_t colmod = 0x55, madctl = 0x48;
  command(0x3A);
  data(&colmod, 1);
  command(0x36);
  data(&madctl, 1);
  command(0x29); // DISPON
  const size_t bytes = W * H * sizeof(uint16_t);
  fb = (uint16_t *)ps_malloc(bytes);
  uintptr_t at = (uintptr_t)fb;
  Serial.printf("frame buffer %u in psram %d\n", (unsigned)bytes, (at >= 0x3C000000 && at < 0x3E000000) ? 1 : 0);
}

int n = 0;

void loop() {
  if (fb == nullptr) {
    delay(1000);
    return;
  }
  draw(n);
  window(0, 0, W - 1, H - 1);
  command(0x2C); // RAMWR
  data((const uint8_t *)fb, W * H * sizeof(uint16_t));
  Serial.printf("frame %d\n", n);
  n++;
  delay(100);
}
