// mega/far-code — tests assert: code and data past 128 KiB run (22-bit PC, 3-byte return
// addresses, EIND/RAMPZ). Five 26,000-byte tables (tables.c, section .fini8 — linked after all
// other code, so the Arduino core's own PROGMEM stays below 64 KiB) push farFunction (.fini7)
// past 0x20000. At 115200 baud Serial prints each table's first and last byte read with ELPM
// ("tables 10 1F 20 2F 30 3F 40 4F 50 5F"), farFunction(14) called directly ("direct 43") and
// farFunction(100) through a function pointer, i.e. a linker trampoline ("pointer 301"), then
// "far ok". farFunction waits 3 ms inside, so timer 0's interrupt lands in far code and returns.
#include <avr/pgmspace.h>

extern "C" {
extern const unsigned char table0[], table1[], table2[], table3[], table4[];
__attribute__((section(".fini7"), noinline, used)) uint16_t farFunction(uint16_t x) {
  delayMicroseconds(3000);
  return x * 3 + 1;
}
}

#define FAR_BYTE(table, i) pgm_read_byte_far(pgm_get_far_address(table) + (i))

uint16_t (*volatile through)(uint16_t) = farFunction;

void printHex(uint8_t b) {
  Serial.print(' ');
  Serial.print(b, HEX);
}

void setup() {
  Serial.begin(115200);
  Serial.print("tables");
  printHex(FAR_BYTE(table0, 0));
  printHex(FAR_BYTE(table0, 25999));
  printHex(FAR_BYTE(table1, 0));
  printHex(FAR_BYTE(table1, 25999));
  printHex(FAR_BYTE(table2, 0));
  printHex(FAR_BYTE(table2, 25999));
  printHex(FAR_BYTE(table3, 0));
  printHex(FAR_BYTE(table3, 25999));
  printHex(FAR_BYTE(table4, 0));
  printHex(FAR_BYTE(table4, 25999));
  Serial.println();
  Serial.print("direct ");
  Serial.println(farFunction(14));
  Serial.print("pointer ");
  Serial.println(through(100));
  Serial.println("far ok");
}

void loop() {}
