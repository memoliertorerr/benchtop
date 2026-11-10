// rfid-door — the gallery's access-control door: an RC522 (SDA on 10, RST on 9) under the MFRC522
// library, a servo lock on 6, a green LED on 4 and a red one on 5. The card with UID A3 F1 C5 2E
// opens the door: "granted A3 F1 C5 2E", the green LED and the servo at 90° for 2 s, then
// "locked". Any other tag (the key fob) is refused: "denied <uid>", the red LED for 1 s.

#include <SPI.h>
#include <MFRC522.h>
#include <Servo.h>

const byte GREEN = 4, RED = 5, LOCK = 6;
const byte ALLOWED[4] = {0xA3, 0xF1, 0xC5, 0x2E};

MFRC522 rfid(10, 9);
Servo lock;

void setup() {
  Serial.begin(115200);
  SPI.begin();
  rfid.PCD_Init();
  pinMode(GREEN, OUTPUT);
  pinMode(RED, OUTPUT);
  lock.attach(LOCK);
  lock.write(0);
  Serial.println("locked");
}

void printUid() {
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (i > 0) Serial.print(' ');
    if (rfid.uid.uidByte[i] < 0x10) Serial.print('0');
    Serial.print(rfid.uid.uidByte[i], HEX);
  }
  Serial.println();
}

void loop() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  const bool allowed = rfid.uid.size == 4 && memcmp(rfid.uid.uidByte, ALLOWED, 4) == 0;
  Serial.print(allowed ? "granted " : "denied ");
  printUid();
  rfid.PICC_HaltA();
  if (allowed) {
    digitalWrite(GREEN, HIGH);
    lock.write(90);
    delay(2000);
    lock.write(0);
    digitalWrite(GREEN, LOW);
    Serial.println("locked");
  } else {
    digitalWrite(RED, HIGH);
    delay(1000);
    digitalWrite(RED, LOW);
  }
}
