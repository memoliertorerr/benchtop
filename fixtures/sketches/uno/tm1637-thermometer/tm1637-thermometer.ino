// tm1637-thermometer — tests assert: a DS18B20 on pin 2 (a 4.7 kOhm pull-up to 5V) read by
// DallasTemperature 4.0.6 (OneWire 2.3.8) at 12 bits every second, shown by TM1637Display 1.2.0 on
// a TM1637 module (CLK 3, DIO 4) as the rounded whole degrees, a degree sign and C — "21°C", " 7°C",
// "-5°C"; three-digit and below -9 the degree sign gives way ("125C", "-12C") — at brightness 5, and
// printed as "t <celsius, 2 decimals>" at 115200 baud ("t no sensor" and "----" without one).

#include <OneWire.h>
#include <DallasTemperature.h>
#include <TM1637Display.h>

OneWire oneWire(2);
DallasTemperature sensors(&oneWire);
TM1637Display display(3, 4);

const uint8_t DEGREE = SEG_A | SEG_B | SEG_F | SEG_G;
const uint8_t CELSIUS = SEG_A | SEG_D | SEG_E | SEG_F;
const uint8_t MINUS = SEG_G;

void setup() {
  Serial.begin(115200);
  sensors.begin();
  display.setBrightness(5);
}

void loop() {
  sensors.requestTemperatures();
  float c = sensors.getTempCByIndex(0);
  uint8_t segments[4] = {0, 0, DEGREE, CELSIUS};
  if (c == DEVICE_DISCONNECTED_C) {
    segments[0] = segments[1] = segments[2] = segments[3] = MINUS;
    Serial.println("t no sensor");
  } else {
    int whole = (int)lround(c);
    int magnitude = abs(whole);
    if (whole >= 100) {  // up to 125: "125C"
      segments[0] = display.encodeDigit(magnitude / 100);
      segments[1] = display.encodeDigit(magnitude / 10 % 10);
      segments[2] = display.encodeDigit(magnitude % 10);
    } else if (whole <= -10) {  // "-12C"
      segments[0] = MINUS;
      segments[1] = display.encodeDigit(magnitude / 10);
      segments[2] = display.encodeDigit(magnitude % 10);
    } else {  // " 21°C", "-5°C"
      segments[0] = whole < 0 ? MINUS : magnitude >= 10 ? display.encodeDigit(magnitude / 10) : 0;
      segments[1] = display.encodeDigit(magnitude % 10);
    }
    Serial.print("t ");
    Serial.println(c, 2);
  }
  display.setSegments(segments);
  delay(1000);
}
