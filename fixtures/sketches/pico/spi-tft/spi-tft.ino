// spi-tft — tests assert (BT61): the Uno/ESP32 TFT demo on a Raspberry Pi Pico: the ILI9341 on SPI0
// (SCK GP18, MOSI GP19, MISO GP16, arduino-pico's default SPI) with CS GP17, D/C GP20, RST
// GP21, 8 MHz; the same picture, "drawn", and the digit counter (on USB serial).
#include <SPI.h>

const uint8_t TFT_CS = 17, TFT_DC = 20, TFT_RST = 21;

// A sketch-local ILI9341 driver (no library): commands and data over hardware SPI, D/C low for
// a command byte, CS held low around each transfer.
const uint16_t BLACK = 0x0000, RED = 0xF800, GREEN = 0x07E0, BLUE = 0x001F, WHITE = 0xFFFF, YELLOW = 0xFFE0;

// 5×7 glyphs, one byte a column, bit 0 the top row: the letters of "BENCHTOP" and the digits.
const char GLYPH_CHARS[] = "BENCHTOP0123456789";
const uint8_t GLYPHS[][5] = {
  {0x7F, 0x49, 0x49, 0x49, 0x36}, {0x7F, 0x49, 0x49, 0x49, 0x41}, {0x7F, 0x04, 0x08, 0x10, 0x7F},
  {0x3E, 0x41, 0x41, 0x41, 0x22}, {0x7F, 0x08, 0x08, 0x08, 0x7F}, {0x01, 0x01, 0x7F, 0x01, 0x01},
  {0x3E, 0x41, 0x41, 0x41, 0x3E}, {0x7F, 0x09, 0x09, 0x09, 0x06},
  {0x3E, 0x51, 0x49, 0x45, 0x3E}, {0x00, 0x42, 0x7F, 0x40, 0x00}, {0x42, 0x61, 0x51, 0x49, 0x46},
  {0x21, 0x41, 0x45, 0x4B, 0x31}, {0x18, 0x14, 0x12, 0x7F, 0x10}, {0x27, 0x45, 0x45, 0x45, 0x39},
  {0x3C, 0x4A, 0x49, 0x49, 0x30}, {0x01, 0x71, 0x09, 0x05, 0x03}, {0x36, 0x49, 0x49, 0x49, 0x36},
  {0x06, 0x49, 0x49, 0x29, 0x1E},
};

void command(uint8_t c) {
  digitalWrite(TFT_DC, LOW);
  digitalWrite(TFT_CS, LOW);
  SPI.transfer(c);
  digitalWrite(TFT_CS, HIGH);
}

void data16(uint16_t d) {
  digitalWrite(TFT_DC, HIGH);
  digitalWrite(TFT_CS, LOW);
  SPI.transfer(d >> 8);
  SPI.transfer(d & 0xFF);
  digitalWrite(TFT_CS, HIGH);
}

void data8(uint8_t d) {
  digitalWrite(TFT_DC, HIGH);
  digitalWrite(TFT_CS, LOW);
  SPI.transfer(d);
  digitalWrite(TFT_CS, HIGH);
}

void fillRect(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint16_t color) {
  command(0x2A); // CASET
  data16(x);
  data16(x + w - 1);
  command(0x2B); // PASET
  data16(y);
  data16(y + h - 1);
  command(0x2C); // RAMWR
  digitalWrite(TFT_DC, HIGH);
  digitalWrite(TFT_CS, LOW);
  for (uint32_t n = (uint32_t)w * h; n > 0; n--) {
    SPI.transfer(color >> 8);
    SPI.transfer(color & 0xFF);
  }
  digitalWrite(TFT_CS, HIGH);
}

void drawChar(uint16_t x, uint16_t y, char ch, uint16_t color, uint8_t scale) {
  const char *at = strchr(GLYPH_CHARS, ch);
  if (at == NULL) return;
  const uint8_t *glyph = GLYPHS[at - GLYPH_CHARS];
  for (uint8_t col = 0; col < 5; col++)
    for (uint8_t row = 0; row < 7; row++)
      if (glyph[col] & (1 << row)) fillRect(x + col * scale, y + row * scale, scale, scale, color);
}

void drawText(uint16_t x, uint16_t y, const char *text, uint16_t color, uint8_t scale) {
  for (; *text; text++, x += 6 * scale) drawChar(x, y, *text, color, scale);
}

void setup() {
  Serial.begin(115200);
  pinMode(TFT_CS, OUTPUT);
  pinMode(TFT_DC, OUTPUT);
  pinMode(TFT_RST, OUTPUT);
  digitalWrite(TFT_CS, HIGH);
  SPI.begin();
  SPI.beginTransaction(SPISettings(8000000, MSBFIRST, SPI_MODE0));
  digitalWrite(TFT_RST, LOW); // hardware reset
  delay(10);
  digitalWrite(TFT_RST, HIGH);
  delay(10);
  command(0x01); // SWRESET
  delay(120);
  command(0x11); // SLPOUT
  delay(120);
  command(0x3A); // COLMOD: 16-bit
  data8(0x55);
  command(0x36); // MADCTL: MX | BGR (portrait, rotation 0)
  data8(0x48);
  command(0x29); // DISPON
  fillRect(0, 0, 240, 320, BLACK);
  fillRect(10, 10, 100, 50, RED);
  fillRect(130, 10, 100, 50, GREEN);
  fillRect(10, 70, 220, 40, BLUE);
  drawText(10, 130, "BENCHTOP", WHITE, 3);
  Serial.println("drawn");
}

uint8_t n = 0;

void loop() {
  fillRect(10, 200, 20, 28, BLACK);
  char digit[2] = {(char)('0' + n), 0};
  drawText(10, 200, digit, YELLOW, 4);
  Serial.println(n);
  n = (n + 1) % 10;
  delay(500);
}
