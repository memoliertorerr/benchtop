// ledcontrol — tests assert: LedControl 1.0.6 on DIN 12, CLK 11, CS 10 with two MAX7219 modules
// chained: device 0 an 8-digit 7-segment module (on the Uno), its DOUT into device 1, an 8x8
// matrix. LedControl bit-bangs (shiftOut) and uses no-decode mode with its own font. Setup wakes
// both at intensity 8, shows "HELP 123" (digit 7 the leftmost; the point after the 3) and a smiley
// on the matrix, and prints "drawn" at 115200 baud. Then every 100 ms digits 0-3 count up
// ("n=<count>"), and the matrix's top row shows the count's low byte.

#include <LedControl.h>

LedControl lc(12, 11, 10, 2);

const byte SMILEY[8] = {0x3C, 0x42, 0xA5, 0x81, 0xA5, 0x99, 0x42, 0x3C};

void setup() {
  Serial.begin(115200);
  for (int d = 0; d < 2; d++) {
    lc.shutdown(d, false);
    lc.setIntensity(d, 8);
    lc.clearDisplay(d);
  }
  lc.setChar(0, 7, 'H', false);
  lc.setChar(0, 6, 'E', false);
  lc.setChar(0, 5, 'L', false);
  lc.setChar(0, 4, 'P', false);
  lc.setChar(0, 3, ' ', false);
  lc.setDigit(0, 2, 1, false);
  lc.setDigit(0, 1, 2, false);
  lc.setDigit(0, 0, 3, true);
  for (int r = 0; r < 8; r++) lc.setRow(1, r, SMILEY[r]);
  Serial.println("drawn");
  delay(500);
}

unsigned int count = 0;

void loop() {
  unsigned int v = count;
  for (int d = 0; d < 4; d++) {
    lc.setDigit(0, d, v % 10, false);
    v /= 10;
  }
  lc.setRow(1, 0, count & 0xFF);
  Serial.print("n=");
  Serial.println(count);
  count++;
  delay(100);
}
