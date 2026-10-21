// lcd-8bit-2004 — tests assert: LiquidCrystal in 8-bit mode (RS=D12, E=D11, D0..D7 = D9..D2, RW
// tied to GND) on a 20x4 LCD shows exactly these four 20-character rows:
//   "Benchtop 20x4 8-bit!" / "Row 1 ABCDEFGHIJKLMN" / "Row 2 0123456789+-*/" / "Row 3 abcdefghijklmn"
// then puts the cursor at column 5, row 3 with cursor() and blink() on.
#include <LiquidCrystal.h>

LiquidCrystal lcd(12, 11, 9, 8, 7, 6, 5, 4, 3, 2);

void setup() {
  lcd.begin(20, 4);
  lcd.setCursor(0, 0);
  lcd.print("Benchtop 20x4 8-bit!");
  lcd.setCursor(0, 1);
  lcd.print("Row 1 ABCDEFGHIJKLMN");
  lcd.setCursor(0, 2);
  lcd.print("Row 2 0123456789+-*/");
  lcd.setCursor(0, 3);
  lcd.print("Row 3 abcdefghijklmn");
  lcd.setCursor(5, 3);
  lcd.cursor();
  lcd.blink();
}

void loop() {
}
