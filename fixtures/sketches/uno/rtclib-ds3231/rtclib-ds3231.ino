// rtclib-ds3231 — tests assert: a ZS-042 DS3231 module (SDA A4, SCL A5) under RTClib 2.1.4. Setup
// prints "lost power" (OSF set) or "kept time", sets 2026-11-10 12:34:50, turns the square wave and
// 32K off, sets alarm 1 for seconds 55 (DS3231_A1_Second), and prints "temp <celsius>". Then each
// second it prints "YYYY/MM/DD hh:mm:ss <day>" and, when alarmFired(1), "alarm" and clears it.

#include <RTClib.h>

RTC_DS3231 rtc;
const char *DAYS[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};

void setup() {
  Serial.begin(115200);
  if (!rtc.begin()) {
    Serial.println("no rtc");
    for (;;) {
    }
  }
  Serial.println(rtc.lostPower() ? "lost power" : "kept time");
  rtc.adjust(DateTime(2026, 11, 10, 12, 34, 50));
  rtc.writeSqwPinMode(DS3231_OFF);
  rtc.disable32K();
  rtc.clearAlarm(1);
  rtc.setAlarm1(DateTime(2026, 11, 10, 12, 34, 55), DS3231_A1_Second);
  Serial.print("temp ");
  Serial.println(rtc.getTemperature(), 2);
}

uint8_t last = 0xFF;

void loop() {
  DateTime now = rtc.now();
  if (now.second() != last) {
    last = now.second();
    char line[32];
    snprintf(line, sizeof line, "%04u/%02u/%02u %02u:%02u:%02u %s", now.year(), now.month(), now.day(), now.hour(), now.minute(),
             now.second(), DAYS[now.dayOfTheWeek()]);
    Serial.println(line);
  }
  if (rtc.alarmFired(1)) {
    Serial.println("alarm");
    rtc.clearAlarm(1);
  }
  delay(50);
}
