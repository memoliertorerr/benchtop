// sd-log — Arduino's SD library on a microSD card module (CS on D10, SPI on D11-D13). Tests
// assert: UART0 at 115200 baud prints "sd: ok", then "file: <NAME> <size>" for each file in the
// card's root, "config: <CONFIG.TXT's contents>" when it exists, appends three lines to LOG.TXT
// ("line 0".."line 2", plus one more per run), prints "log: <size>" and the log, writes
// DATA/A.CSV, and prints "done". "sd: begin failed" when there is no card.
#include <SPI.h>
#include <SD.h>

const int CS_PIN = 10;

void setup() {
  Serial.begin(115200);
  if (!SD.begin(CS_PIN)) {
    Serial.println("sd: begin failed");
    return;
  }
  Serial.println("sd: ok");
  File root = SD.open("/");
  while (true) {
    File entry = root.openNextFile();
    if (!entry) break;
    Serial.print("file: ");
    Serial.print(entry.name());
    Serial.print(' ');
    Serial.println(entry.size());
    entry.close();
  }
  root.close();
  File config = SD.open("CONFIG.TXT");
  if (config) {
    Serial.print("config: ");
    while (config.available()) Serial.write(config.read());
    config.close();
  }
  File log = SD.open("LOG.TXT", FILE_WRITE);
  for (int i = 0; i < 3; i++) {
    log.print("line ");
    log.println(i);
  }
  log.close();
  File back = SD.open("LOG.TXT");
  Serial.print("log: ");
  Serial.println(back.size());
  while (back.available()) Serial.write(back.read());
  back.close();
  SD.mkdir("DATA");
  File csv = SD.open("DATA/A.CSV", FILE_WRITE);
  csv.println("t,v");
  csv.println("0,512");
  csv.close();
  Serial.println("done");
}

void loop() {
}
