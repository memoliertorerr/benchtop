// sd-log — tests assert (BT90): arduino-pico's SD library (SdFat) on a microSD card module on
// SPI0 (SCK GP18, MOSI GP19, MISO GP16) with CS GP17. USB serial prints "sd: ok", "file: <name>
// <size>" for each file in the root, "config: <config.txt>" when it exists, appends three lines
// to log.txt, prints "log: <size>" and the log, writes "data/Long Name Readings.csv", and
// prints "done".
#include <SD.h>
#include <SPI.h>

void setup() {
  Serial.begin(115200);
  delay(100);
  if (!SD.begin(17)) {
    Serial.println("sd: begin failed");
    return;
  }
  Serial.println("sd: ok");
  File root = SD.open("/");
  for (File f = root.openNextFile(); f; f = root.openNextFile()) {
    Serial.printf("file: %s %u\n", f.name(), (unsigned)f.size());
    f.close();
  }
  root.close();
  File config = SD.open("config.txt");
  if (config) {
    Serial.print("config: ");
    while (config.available()) Serial.write(config.read());
    config.close();
  }
  File log = SD.open("log.txt", FILE_WRITE);
  for (int i = 0; i < 3; i++) log.printf("line %d\n", i);
  log.close();
  File back = SD.open("log.txt");
  Serial.printf("log: %u\n", (unsigned)back.size());
  while (back.available()) Serial.write(back.read());
  back.close();
  SD.mkdir("data");
  File csv = SD.open("data/Long Name Readings.csv", FILE_WRITE);
  csv.println("t,v");
  csv.println("0,512");
  csv.close();
  Serial.println("done");
}

void loop() {
  delay(1000);
}
