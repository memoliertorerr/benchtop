// mfrc522-logger — tests assert: an RC522 on the ESP32's VSPI (SCK 18, MISO 19, MOSI 23, SDA on 5,
// RST on 22) under the MFRC522 library 1.4.12. At 115200 baud "ready"; then for each MIFARE
// Classic laid on the reader: its UID, then block 4 — a visit counter kept on the card itself —
// authenticated with key A FFFFFFFFFFFFh, read, incremented, written and read back:
// "card <uid> visit <n> at <ms> ms" (or the library's status name where a step fails); then
// PICC_HaltA and PCD_StopCrypto1. Taking the card off and putting it back counts one more visit.

#include <SPI.h>
#include <MFRC522.h>

MFRC522 rfid(5, 22);
MFRC522::MIFARE_Key key;

void setup() {
  Serial.begin(115200);
  SPI.begin();
  rfid.PCD_Init();
  for (byte i = 0; i < 6; i++) key.keyByte[i] = 0xFF;
  Serial.println("ready");
}

void printUid() {
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (i > 0) Serial.print(' ');
    if (rfid.uid.uidByte[i] < 0x10) Serial.print('0');
    Serial.print(rfid.uid.uidByte[i], HEX);
  }
}

bool step(const char *what, MFRC522::StatusCode status) {
  if (status == MFRC522::STATUS_OK) return true;
  Serial.print(what);
  Serial.print(' ');
  Serial.println(MFRC522::GetStatusCodeName(status));
  return false;
}

void loop() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  const byte block = 4;
  byte data[18];
  byte size = sizeof(data);
  if (step("auth", rfid.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_A, 7, &key, &rfid.uid)) &&
      step("read", rfid.MIFARE_Read(block, data, &size))) {
    uint32_t visits = (uint32_t)data[0] | ((uint32_t)data[1] << 8) | ((uint32_t)data[2] << 16) | ((uint32_t)data[3] << 24);
    visits++;
    for (byte i = 0; i < 16; i++) data[i] = 0;
    for (byte i = 0; i < 4; i++) data[i] = (visits >> (8 * i)) & 0xFF;
    size = sizeof(data);
    byte check[18];
    if (step("write", rfid.MIFARE_Write(block, data, 16)) && step("read back", rfid.MIFARE_Read(block, check, &size))) {
      uint32_t stored = (uint32_t)check[0] | ((uint32_t)check[1] << 8) | ((uint32_t)check[2] << 16) | ((uint32_t)check[3] << 24);
      Serial.print("card ");
      printUid();
      Serial.print(" visit ");
      Serial.print(stored);
      Serial.print(" at ");
      Serial.print(millis());
      Serial.println(" ms");
    }
  }
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}
