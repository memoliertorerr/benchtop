// mfrc522-dump — tests assert: an RC522 on the Uno's SPI (SDA on 10, RST on 9) under the MFRC522
// library 1.4.12. At 115200 baud: PCD_Init, then PCD_DumpVersionToSerial ("Firmware Version: 0x92 =
// v2.0"), "ready"; each new card is dumped by PICC_DumpToSerial — its UID, SAK and type, then for a
// MIFARE Classic every sector authenticated with key A FFFFFFFFFFFFh and its blocks with their
// access bits, for an NTAG its pages — which ends with PICC_HaltA, so a card is dumped once while it
// lies on the reader.

#include <SPI.h>
#include <MFRC522.h>

MFRC522 rfid(10, 9);

void setup() {
  Serial.begin(115200);
  SPI.begin();
  rfid.PCD_Init();
  rfid.PCD_DumpVersionToSerial();
  Serial.println("ready");
}

void loop() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  rfid.PICC_DumpToSerial(&rfid.uid);
  Serial.println("done");
}
