// rfid-uid — tests assert: an RC522 on the Uno's SPI (SDA on 10, SCK 13, MOSI 11, MISO 12, RST on
// 9, 3.3V on 3.3V) driven by our own few functions, no library. At 115200 baud it prints
// "version 0x<hex>", resets the chip through RST, sets TAuto with a 25 ms timeout, turns the antenna
// on, and times a REQA with nothing on the reader: "no card <µs> us". Then every 50 ms it sends
// REQA; a card answers with its ATQA, goes through anticollision and SELECT per cascade level and
// prints "uid <bytes> sak <hex> atqa <hex4>". A MIFARE Classic (SAK 08h) is authenticated with key A
// FFFFFFFFFFFFh for block 0 and its manufacturer block printed: "block0 <16 bytes>" (or "auth
// failed"); an NTAG (SAK 00h) has pages 0–3 read: "pages <16 bytes>". Then HLTA ("halted"): a
// halted card stays quiet until it is taken off the reader and put back.

#include <SPI.h>

const uint8_t SS_PIN = 10;
const uint8_t RST_PIN = 9;

// MFRC522 registers and commands (NXP's datasheet rev 3.9, Tables 20 and 149).
const uint8_t COMMAND = 0x01, COM_IRQ = 0x04, DIV_IRQ = 0x05, ERROR = 0x06, STATUS2 = 0x08, FIFO_DATA = 0x09,
              FIFO_LEVEL = 0x0A, CONTROL = 0x0C, BIT_FRAMING = 0x0D, COLL = 0x0E, MODE = 0x11, TX_CONTROL = 0x14,
              TX_ASK = 0x15, CRC_H = 0x21, CRC_L = 0x22, T_MODE = 0x2A, T_PRESCALER = 0x2B, T_RELOAD_H = 0x2C,
              T_RELOAD_L = 0x2D, VERSION = 0x37;
const uint8_t IDLE = 0x00, CALC_CRC = 0x03, TRANSCEIVE = 0x0C, MF_AUTHENT = 0x0E;

const SPISettings SETTINGS(4000000, MSBFIRST, SPI_MODE0);

void writeRegs(uint8_t reg, const uint8_t *data, uint8_t n) {
  SPI.beginTransaction(SETTINGS);
  digitalWrite(SS_PIN, LOW);
  SPI.transfer(reg << 1);
  for (uint8_t i = 0; i < n; i++) SPI.transfer(data[i]);
  digitalWrite(SS_PIN, HIGH);
  SPI.endTransaction();
}

void writeReg(uint8_t reg, uint8_t value) { writeRegs(reg, &value, 1); }

/** `n` reads of one register in one frame (the address repeated, 00h last). */
void readRegs(uint8_t reg, uint8_t *out, uint8_t n) {
  SPI.beginTransaction(SETTINGS);
  digitalWrite(SS_PIN, LOW);
  SPI.transfer(0x80 | (reg << 1));
  for (uint8_t i = 0; i < n; i++) out[i] = SPI.transfer(i + 1 < n ? 0x80 | (reg << 1) : 0);
  digitalWrite(SS_PIN, HIGH);
  SPI.endTransaction();
}

uint8_t readReg(uint8_t reg) {
  uint8_t v;
  readRegs(reg, &v, 1);
  return v;
}

/** CRC_A by the chip's coprocessor, LSB first into out[0..1]. */
void crcA(const uint8_t *data, uint8_t n, uint8_t *out) {
  writeReg(COMMAND, IDLE);
  writeReg(DIV_IRQ, 0x04);
  writeReg(FIFO_LEVEL, 0x80);
  writeRegs(FIFO_DATA, data, n);
  writeReg(COMMAND, CALC_CRC);
  while (!(readReg(DIV_IRQ) & 0x04)) {
  }
  writeReg(COMMAND, IDLE);
  out[0] = readReg(CRC_L);
  out[1] = readReg(CRC_H);
}

// 0 ok, 1 timeout (TimerIRq), 2 error.
uint8_t talk(uint8_t command, const uint8_t *send, uint8_t n, uint8_t lastBits, uint8_t *back, uint8_t *backLength) {
  writeReg(COMMAND, IDLE);
  writeReg(COM_IRQ, 0x7F);
  writeReg(FIFO_LEVEL, 0x80);
  writeRegs(FIFO_DATA, send, n);
  writeReg(BIT_FRAMING, lastBits);
  writeReg(COMMAND, command);
  if (command == TRANSCEIVE) writeReg(BIT_FRAMING, 0x80 | lastBits);
  const uint8_t done = command == MF_AUTHENT ? 0x10 : 0x20;
  const uint32_t start = millis();
  for (;;) {
    uint8_t irq = readReg(COM_IRQ);
    if (irq & done) break;
    if (irq & 0x01) return 1;
    if (millis() - start > 40) return 1;
  }
  if (readReg(ERROR) & 0x13) return 2;
  if (back != 0) {
    uint8_t level = readReg(FIFO_LEVEL);
    if (level > *backLength) return 2;
    *backLength = level;
    readRegs(FIFO_DATA, back, level);
  }
  return 0;
}

void printHex(const uint8_t *bytes, uint8_t n) {
  for (uint8_t i = 0; i < n; i++) {
    if (i > 0) Serial.print(' ');
    if (bytes[i] < 0x10) Serial.print('0');
    Serial.print(bytes[i], HEX);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(SS_PIN, OUTPUT);
  digitalWrite(SS_PIN, HIGH);
  SPI.begin();
  pinMode(RST_PIN, OUTPUT);
  digitalWrite(RST_PIN, LOW);
  delayMicroseconds(10);
  digitalWrite(RST_PIN, HIGH);
  delay(50);
  Serial.print("version 0x");
  Serial.println(readReg(VERSION), HEX);
  writeReg(T_MODE, 0x80);  // TAuto, prescaler 0A9h: 40 kHz
  writeReg(T_PRESCALER, 0xA9);
  writeReg(T_RELOAD_H, 0x03);  // 1000: 25 ms
  writeReg(T_RELOAD_L, 0xE8);
  writeReg(TX_ASK, 0x40);  // 100 % ASK
  writeReg(MODE, 0x3D);    // CRC preset 6363h
  writeReg(TX_CONTROL, readReg(TX_CONTROL) | 0x03);
  writeReg(COLL, 0x00);
  const uint8_t reqa = 0x26;
  uint8_t atqa[2];
  uint8_t length = 2;
  const uint32_t t = micros();
  const uint8_t result = talk(TRANSCEIVE, &reqa, 1, 7, atqa, &length);
  const uint32_t us = micros() - t;
  Serial.print(result == 1 ? "no card " : "card ");
  Serial.print(us);
  Serial.println(" us");
}

void loop() {
  delay(50);
  const uint8_t reqa = 0x26;
  uint8_t atqa[2];
  uint8_t length = 2;
  if (talk(TRANSCEIVE, &reqa, 1, 7, atqa, &length) != 0 || length != 2) return;
  uint8_t uid[10];
  uint8_t size = 0;
  uint8_t sak = 0;
  for (uint8_t level = 0; level < 3; level++) {
    const uint8_t sel = 0x93 + 2 * level;
    const uint8_t anticollision[2] = {sel, 0x20};
    uint8_t cl[5];
    length = 5;
    if (talk(TRANSCEIVE, anticollision, 2, 0, cl, &length) != 0 || length != 5) return;
    if ((cl[0] ^ cl[1] ^ cl[2] ^ cl[3]) != cl[4]) {
      Serial.println("bcc wrong");
      return;
    }
    uint8_t select[9] = {sel, 0x70, cl[0], cl[1], cl[2], cl[3], cl[4]};
    crcA(select, 7, select + 7);
    uint8_t answer[3];
    length = 3;
    if (talk(TRANSCEIVE, select, 9, 0, answer, &length) != 0 || length != 3) return;
    uint8_t check[2];
    crcA(answer, 1, check);
    if (check[0] != answer[1] || check[1] != answer[2]) {
      Serial.println("sak crc wrong");
      return;
    }
    const uint8_t from = cl[0] == 0x88 ? 1 : 0;
    for (uint8_t i = from; i < 4; i++) uid[size++] = cl[i];
    sak = answer[0];
    if (!(sak & 0x04)) break;
  }
  Serial.print("uid ");
  printHex(uid, size);
  Serial.print(" sak ");
  if (sak < 0x10) Serial.print('0');
  Serial.print(sak, HEX);
  Serial.print(" atqa ");
  uint8_t atqaShown[2] = {atqa[1], atqa[0]};
  printHex(atqaShown, 2);
  Serial.println();
  uint8_t data[18];
  if (sak == 0x08) {
    uint8_t auth[12] = {0x60, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
    for (uint8_t i = 0; i < 4; i++) auth[8 + i] = uid[size - 4 + i];
    if (talk(MF_AUTHENT, auth, 12, 0, 0, 0) != 0 || !(readReg(STATUS2) & 0x08)) {
      Serial.println("auth failed");
    } else {
      uint8_t read[4] = {0x30, 0x00};
      crcA(read, 2, read + 2);
      length = 18;
      if (talk(TRANSCEIVE, read, 4, 0, data, &length) == 0 && length == 18) {
        Serial.print("block0 ");
        printHex(data, 16);
        Serial.println();
      }
    }
  } else if (sak == 0x00) {
    uint8_t read[4] = {0x30, 0x00};
    crcA(read, 2, read + 2);
    length = 18;
    if (talk(TRANSCEIVE, read, 4, 0, data, &length) == 0 && length == 18) {
      Serial.print("pages ");
      printHex(data, 16);
      Serial.println();
    }
  }
  uint8_t hlta[4] = {0x50, 0x00};
  crcA(hlta, 2, hlta + 2);
  talk(TRANSCEIVE, hlta, 4, 0, 0, 0);  // no answer is the answer
  writeReg(STATUS2, readReg(STATUS2) & ~0x08);
  Serial.println("halted");
}
