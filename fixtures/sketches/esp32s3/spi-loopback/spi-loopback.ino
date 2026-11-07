// spi-loopback — tests assert (BT125): each run sends 0x00–0xFF with CS low (digitalWrite) to a
// device that answers ~mosi and prints "<name> sum=<sum of the answers>" (32640 when every byte
// arrives): FSPI (SPI.begin(): the S3's defaults SCK 12, MISO 13, MOSI 11, CS 10) at 1 MHz mode 0 MSB
// first ("f1m"), 8 MHz mode 1 ("f8m"), 1 MHz mode 2 LSB first ("flsb"), 1 MHz mode 3 ("fm3");
// then 16 bytes with CS high ("nocs", the device must see none); then "done".
#include <SPI.h>

void run(uint32_t hz, uint8_t order, uint8_t mode, const char *name) {
  SPI.beginTransaction(SPISettings(hz, order, mode));
  digitalWrite(10, LOW);
  uint32_t sum = 0;
  for (int i = 0; i < 256; i++) sum += SPI.transfer((uint8_t)i);
  digitalWrite(10, HIGH);
  SPI.endTransaction();
  Serial.printf("%s sum=%lu\n", name, (unsigned long)sum);
}

void setup() {
  Serial.begin(115200);
  pinMode(10, OUTPUT);
  digitalWrite(10, HIGH);
  SPI.begin();
  run(1000000, MSBFIRST, SPI_MODE0, "f1m");
  run(8000000, MSBFIRST, SPI_MODE1, "f8m");
  run(1000000, LSBFIRST, SPI_MODE2, "flsb");
  run(1000000, MSBFIRST, SPI_MODE3, "fm3");
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  uint32_t idle = 0;
  for (int i = 0; i < 16; i++) idle += SPI.transfer((uint8_t)i);
  SPI.endTransaction();
  Serial.printf("nocs sum=%lu\n", (unsigned long)idle);
  Serial.println("done");
}

void loop() {
  delay(1000);
}
