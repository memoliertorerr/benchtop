// ds18b20 — tests assert: two DS18B20s on one 1-Wire line on pin 2 (a 4.7 kOhm pull-up to 5V),
// driven as the OneWire library does (the pin's port registers, interrupts off inside a slot;
// reset 480/70/410 us, write 1 10/55, write 0 65/5, read 3/10/53). Setup finds every sensor
// with Search ROM, printing "found 28-<serial, MSB first> crc ok" (or "crc bad"), then "sensors
// <n>". Each second it starts a conversion on all (Skip ROM, 44h), polls read slots until done
// and prints "converted in <ms> ms", then reads each sensor's scratchpad by Match ROM, printing
// "28-<serial> <celsius, 4 decimals> C" (or "28-<serial> crc bad").

const int PIN = 2;

uint8_t mask;
volatile uint8_t *modeReg;
volatile uint8_t *outReg;
volatile uint8_t *inReg;

inline void lineLow() {
  *outReg &= ~mask;
  *modeReg |= mask;
}
inline void lineRelease() { *modeReg &= ~mask; }
inline uint8_t lineRead() { return (*inReg & mask) ? 1 : 0; }

uint8_t owReset() {
  noInterrupts();
  lineLow();
  interrupts();
  delayMicroseconds(480);
  noInterrupts();
  lineRelease();
  delayMicroseconds(70);
  uint8_t present = !lineRead();
  interrupts();
  delayMicroseconds(410);
  return present;
}

void owWriteBit(uint8_t v) {
  if (v) {
    noInterrupts();
    lineLow();
    delayMicroseconds(10);
    lineRelease();
    interrupts();
    delayMicroseconds(55);
  } else {
    noInterrupts();
    lineLow();
    delayMicroseconds(65);
    lineRelease();
    interrupts();
    delayMicroseconds(5);
  }
}

uint8_t owReadBit() {
  noInterrupts();
  lineLow();
  delayMicroseconds(3);
  lineRelease();
  delayMicroseconds(10);
  uint8_t r = lineRead();
  interrupts();
  delayMicroseconds(53);
  return r;
}

void owWrite(uint8_t b) {
  for (uint8_t i = 0; i < 8; i++) owWriteBit((b >> i) & 1);
}

uint8_t owRead() {
  uint8_t b = 0;
  for (uint8_t i = 0; i < 8; i++) b |= owReadBit() << i;
  return b;
}

uint8_t crc8(const uint8_t *data, uint8_t len) {
  uint8_t crc = 0;
  while (len--) {
    uint8_t in = *data++;
    for (uint8_t i = 0; i < 8; i++) {
      uint8_t mix = (crc ^ in) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8C;
      in >>= 1;
    }
  }
  return crc;
}

// Maxim's search algorithm (as OneWire::search).
uint8_t rom[8];
int lastDiscrepancy = -1;
bool lastDevice = false;

bool owSearch() {
  if (lastDevice || !owReset()) return false;
  owWrite(0xF0);
  int discrepancy = -1;
  for (int i = 0; i < 64; i++) {
    uint8_t bit = owReadBit();
    uint8_t cmp = owReadBit();
    if (bit && cmp) return false;
    uint8_t dir;
    if (bit != cmp) dir = bit;
    else {
      dir = i < lastDiscrepancy ? (rom[i / 8] >> (i % 8)) & 1 : (i == lastDiscrepancy);
      if (!dir) discrepancy = i;
    }
    if (dir) rom[i / 8] |= 1 << (i % 8);
    else rom[i / 8] &= ~(1 << (i % 8));
    owWriteBit(dir);
  }
  lastDiscrepancy = discrepancy;
  if (discrepancy < 0) lastDevice = true;
  return true;
}

const int MAX = 4;
uint8_t roms[MAX][8];
int count = 0;

void printName(const uint8_t *r) {
  Serial.print("28-");
  for (int i = 6; i >= 1; i--) {
    if (r[i] < 0x10) Serial.print('0');
    Serial.print(r[i], HEX);
  }
}

void setup() {
  Serial.begin(115200);
  mask = digitalPinToBitMask(PIN);
  uint8_t port = digitalPinToPort(PIN);
  modeReg = portModeRegister(port);
  outReg = portOutputRegister(port);
  inReg = portInputRegister(port);
  lineRelease();
  while (count < MAX && owSearch()) {
    memcpy(roms[count], rom, 8);
    Serial.print("found ");
    printName(rom);
    Serial.println(crc8(rom, 7) == rom[7] ? " crc ok" : " crc bad");
    count++;
  }
  Serial.print("sensors ");
  Serial.println(count);
}

void loop() {
  owReset();
  owWrite(0xCC);
  owWrite(0x44);
  unsigned long start = millis();
  while (owReadBit() == 0) {
  }
  Serial.print("converted in ");
  Serial.print(millis() - start);
  Serial.println(" ms");
  for (int s = 0; s < count; s++) {
    owReset();
    owWrite(0x55);
    for (int i = 0; i < 8; i++) owWrite(roms[s][i]);
    owWrite(0xBE);
    uint8_t pad[9];
    for (int i = 0; i < 9; i++) pad[i] = owRead();
    printName(roms[s]);
    if (crc8(pad, 8) != pad[8]) {
      Serial.println(" crc bad");
      continue;
    }
    int16_t raw = (int16_t)((pad[1] << 8) | pad[0]);
    Serial.print(' ');
    Serial.print(raw / 16.0, 4);
    Serial.println(" C");
  }
  delay(1000);
}
