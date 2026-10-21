// uart-ping — tests assert (BT39): Serial at 115200 baud sends "ping\n" every 100 ms. The
// two-board test wires the Uno's TX (D1) to an ESP32's RX2 (GPIO16) running esp32/uart-relay.
void setup() {
  Serial.begin(115200);
}

void loop() {
  Serial.print("ping\n");
  delay(100);
}
