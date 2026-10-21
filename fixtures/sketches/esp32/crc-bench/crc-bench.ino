// crc-bench — tests assert: setup() computes a bitwise CRC-32 (reflected, polynomial
// 0xEDB88320, init and final XOR 0xFFFFFFFF — our own loop, not the ROM's crc32_le) over 8
// rounds of 16 KB where byte i is (i * 7 + 3) & 0xFF, the CRC running on across the rounds,
// and prints "crc=%08x" once on UART0 at 115200 baud. The test computes the value in JS.
static uint8_t buffer[16384];

static uint32_t crc32Bitwise(uint32_t crc, const uint8_t *data, size_t length) {
  for (size_t i = 0; i < length; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
  }
  return crc;
}

void setup() {
  Serial.begin(115200);
  for (size_t i = 0; i < sizeof(buffer); i++) buffer[i] = (uint8_t)((i * 7 + 3) & 0xFF);
  uint32_t crc = 0xFFFFFFFFu;
  for (int round = 0; round < 8; round++) crc = crc32Bitwise(crc, buffer, sizeof(buffer));
  Serial.printf("crc=%08x\n", crc ^ 0xFFFFFFFFu);
}

void loop() {
  delay(1000);
}
