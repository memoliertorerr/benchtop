// i2c-oled — tests assert (BT66, the Pico's sketch on the Pico 2's RISC-V cores): a 128x64 SSD1306 at 0x3C on Wire (I2C0: SDA GP4, SCL GP5),
// through Adafruit SSD1306: a filled 32x16 box at the top left, "PICO" in size-2 text beside
// it, and a seconds counter below, redrawn every second; "frame <n>" on USB serial.
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Wire.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);
int frame = 0;

void setup() {
  Serial.begin(115200);
  Wire.setSDA(4);
  Wire.setSCL(5);
  Wire.begin();
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
}

void loop() {
  display.clearDisplay();
  display.fillRect(0, 0, 32, 16, SSD1306_WHITE);
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(40, 0);
  display.print("PICO");
  display.setTextSize(1);
  display.setCursor(0, 40);
  display.print("t=");
  display.print(frame);
  display.display();
  Serial.print("frame ");
  Serial.println(frame);
  frame++;
  delay(1000);
}
