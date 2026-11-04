// ntp-clock — tests assert (BT105): the time from the network. Joins "benchtop", calls
// configTime(0, 0, "pool.ntp.org") — the access point's gateway answers SNTP itself — and shows
// UTC large on a 128x64 SSD1306 at 0x3C (SDA = GPIO21, SCL = GPIO22), the date below, printing
// "YYYY-MM-DD hh:mm:ss" every second (115200 baud) and "waiting for time" until the first answer.
#include <WiFi.h>
#include <time.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Wire.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);

static void show(const char *big, const char *small) {
  display.clearDisplay();
  display.setTextSize(2);
  display.setCursor(16, 16);
  display.print(big);
  display.setTextSize(1);
  display.setCursor(34, 44);
  display.print(small);
  display.display();
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.setTextColor(SSD1306_WHITE);
  show("WiFi...", "benchtop");
  WiFi.begin("benchtop", "simulated");
  while (WiFi.status() != WL_CONNECTED) delay(50);
  configTime(0, 0, "pool.ntp.org");
  Serial.println("waiting for time");
  show("NTP...", "pool.ntp.org");
}

void loop() {
  struct tm now;
  if (!getLocalTime(&now, 200)) return;
  char text[24];
  strftime(text, sizeof text, "%Y-%m-%d %H:%M:%S", &now);
  Serial.println(text);
  text[10] = '\0';
  show(text + 11, text);
  delay(1000);
}
