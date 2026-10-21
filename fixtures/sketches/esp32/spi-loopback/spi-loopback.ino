// spi-loopback — tests assert (BT36): each run sends 0x00–0xFF with CS low (digitalWrite) to a
// device that answers ~mosi and prints "<name> sum=<sum of the answers>" (32640 when every byte
// arrives): VSPI (SPI.begin(): SCK 18, MISO 19, MOSI 23, CS 5) at 1 MHz mode 0 MSB first
// ("v1m"), 8 MHz mode 1 ("v8m"), 1 MHz mode 2 LSB first ("vlsb"), 1 MHz mode 3 ("vm3"); then 16
// bytes with CS high ("nocs", the device must see none); then HSPI (SCK 14, MISO 12, MOSI 13,
// CS 15) at 1 MHz mode 0 ("h1m"); then "done".
#include <SPI.h>

SPIClass hspi(HSPI);

void run(SPIClass &spi, int cs, uint32_t hz, uint8_t order, uint8_t mode, const char *name) {
  spi.beginTransaction(SPISettings(hz, order, mode));
  digitalWrite(cs, LOW);
  uint32_t sum = 0;
  for (int i = 0; i < 256; i++) sum += spi.transfer((uint8_t)i);
  digitalWrite(cs, HIGH);
  spi.endTransaction();
  Serial.printf("%s sum=%lu\n", name, (unsigned long)sum);
}

void setup() {
  Serial.begin(115200);
  pinMode(5, OUTPUT);
  digitalWrite(5, HIGH);
  pinMode(15, OUTPUT);
  digitalWrite(15, HIGH);
  SPI.begin();
  hspi.begin();
  run(SPI, 5, 1000000, MSBFIRST, SPI_MODE0, "v1m");
  run(SPI, 5, 8000000, MSBFIRST, SPI_MODE1, "v8m");
  run(SPI, 5, 1000000, LSBFIRST, SPI_MODE2, "vlsb");
  run(SPI, 5, 1000000, MSBFIRST, SPI_MODE3, "vm3");
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  uint32_t idle = 0;
  for (int i = 0; i < 16; i++) idle += SPI.transfer((uint8_t)i);
  SPI.endTransaction();
  Serial.printf("nocs sum=%lu\n", (unsigned long)idle);
  run(hspi, 15, 1000000, MSBFIRST, SPI_MODE0, "h1m");
  Serial.println("done");
}

void loop() {
  delay(1000);
}
