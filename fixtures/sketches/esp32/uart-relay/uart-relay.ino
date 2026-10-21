// uart-relay — tests assert (BT39): Serial2 at 115200 baud on RX2/TX2 (GPIO16/GPIO17); every byte
// it receives is written to Serial (UART0, 115200) unchanged, so an Uno's "ping\n" lines show up
// on the ESP32's serial monitor. loop() polls once a millisecond (delay(1) lets the cores idle;
// the 128-byte RX FIFO holds what arrives in between).
void setup() {
  Serial.begin(115200);
  Serial2.begin(115200, SERIAL_8N1, 16, 17);
}

void loop() {
  while (Serial2.available() > 0) Serial.write(Serial2.read());
  delay(1);
}
