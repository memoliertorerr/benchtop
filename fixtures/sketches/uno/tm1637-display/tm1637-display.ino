// tm1637-display — tests assert: TM1637Display 1.2.0 on CLK 2, DIO 3 (a TM1637 4-digit module).
// Setup: brightness 7 (14/16), showNumberDecEx(1234) with the colon, printing "1234:" at 115200
// baud; 500 ms later setSegments "dOnE" (d, O, n, E as raw segments), "done"; 500 ms later the
// display off (setBrightness(7, false) and a write), "off"; 500 ms later brightness 1 (2/16) and
// showNumberDec(42, true) — leading zeros, "0042". Then every 100 ms from 2 s showNumberDec(count)
// right-aligned without zeros, printing "n=<count>".

#include <TM1637Display.h>

TM1637Display display(2, 3);

const uint8_t DONE[] = {
  SEG_B | SEG_C | SEG_D | SEG_E | SEG_G,
  SEG_A | SEG_B | SEG_C | SEG_D | SEG_E | SEG_F,
  SEG_C | SEG_E | SEG_G,
  SEG_A | SEG_D | SEG_E | SEG_F | SEG_G,
};

void setup() {
  Serial.begin(115200);
  display.setBrightness(7);
  display.showNumberDecEx(1234, 0b01000000);
  Serial.println("1234:");
  delay(500);
  display.setSegments(DONE);
  Serial.println("done");
  delay(500);
  display.setBrightness(7, false);
  display.setSegments(DONE);
  Serial.println("off");
  delay(500);
  display.setBrightness(1);
  display.showNumberDec(42, true);
  Serial.println("0042");
  delay(500);
}

int count = 0;

void loop() {
  display.showNumberDec(count, false);
  Serial.print("n=");
  Serial.println(count);
  count++;
  delay(100);
}
