// sd-datalogger — the gallery's SD card example (BT90): an Uno logs a potentiometer (A0) to
// DATALOG.CSV on a microSD card module (CS D10, SPI D11-D13) every 500 ms as "ms,value", and
// echoes each line on Serial at 115200 baud. At start it says whether the file is new or how
// many lines it holds: a reset keeps the card, so the log carries on.
#include <SPI.h>
#include <SD.h>

const int CS_PIN = 10;
unsigned long next = 0;

void setup() {
  Serial.begin(115200);
  if (!SD.begin(CS_PIN)) {
    Serial.println("No card: check the wiring, or put one in the socket.");
    while (true) {
    }
  }
  File old = SD.open("DATALOG.CSV");
  if (old) {
    int lines = 0;
    while (old.available()) {
      if (old.read() == '\n') lines++;
    }
    old.close();
    Serial.print("DATALOG.CSV has ");
    Serial.print(lines);
    Serial.println(" lines");
  } else {
    File log = SD.open("DATALOG.CSV", FILE_WRITE);
    log.println("ms,value");
    log.close();
    Serial.println("New DATALOG.CSV");
  }
}

void loop() {
  unsigned long now = millis();
  if (now < next) return;
  next = now + 500;
  int value = analogRead(A0);
  File log = SD.open("DATALOG.CSV", FILE_WRITE);
  if (!log) {
    Serial.println("Can't open DATALOG.CSV");
    return;
  }
  log.print(now);
  log.print(',');
  log.println(value);
  log.close();
  Serial.print("logged ");
  Serial.print(now);
  Serial.print(',');
  Serial.println(value);
}
