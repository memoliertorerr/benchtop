// sd-log — tests assert (BT90): the ESP32 core's SD library (FatFs over its own SPI driver, CRC
// on) on a microSD card module on VSPI (SCK 18, MISO 19, MOSI 23, CS 5). UART0 at 115200 prints
// "sd: ok <card type> <size in MB>", "file: <name> <size>" for each file in the root,
// "config: <config.txt>" when it exists, appends three lines to /log.txt, prints "log: <size>"
// and the log, writes "/data/Long Name Readings.csv" (a long name), and prints "done".
#include <FS.h>
#include <SD.h>
#include <SPI.h>

void setup() {
  Serial.begin(115200);
  if (!SD.begin(5)) {
    Serial.println("sd: begin failed");
    return;
  }
  Serial.printf("sd: ok %d %llu\n", (int)SD.cardType(), SD.cardSize() / (1024 * 1024));
  File root = SD.open("/");
  for (File f = root.openNextFile(); f; f = root.openNextFile()) {
    Serial.printf("file: %s %u\n", f.name(), (unsigned)f.size());
    f.close();
  }
  root.close();
  File config = SD.open("/config.txt");
  if (config) {
    Serial.print("config: ");
    while (config.available()) Serial.write(config.read());
    config.close();
  }
  File log = SD.open("/log.txt", FILE_APPEND);
  for (int i = 0; i < 3; i++) log.printf("line %d\n", i);
  log.close();
  File back = SD.open("/log.txt");
  Serial.printf("log: %u\n", (unsigned)back.size());
  while (back.available()) Serial.write(back.read());
  back.close();
  SD.mkdir("/data");
  File csv = SD.open("/data/Long Name Readings.csv", FILE_WRITE);
  csv.println("t,v");
  csv.println("0,512");
  csv.close();
  Serial.println("done");
}

void loop() {
  delay(1000);
}
