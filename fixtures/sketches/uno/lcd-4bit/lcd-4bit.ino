// lcd-4bit — tests assert: LiquidCrystal in 4-bit mode (RS=D12, E=D11, D4..D7 = D5, D4, D3, D2,
// RW tied to GND) on a 16x2 LCD. Row 0 shows "Hello, Benchtop!"; row 1 shows "t=<seconds>",
// rewritten whenever the second changes, so at 1.2 s simulated it reads "t=1".
#include <LiquidCrystal.h>

LiquidCrystal lcd(12, 11, 5, 4, 3, 2);
unsigned long shown = 0xFFFFFFFF;

void setup() {
  lcd.begin(16, 2);
  lcd.print("Hello, Benchtop!");
}

void loop() {
  unsigned long seconds = millis() / 1000;
  if (seconds != shown) {
    shown = seconds;
    lcd.setCursor(0, 1);
    lcd.print("t=");
    lcd.print(seconds);
  }
}
