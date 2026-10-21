// uart-chat — tests assert (BT43): the Uno half of a two-board chat. Every 500 ms it sends
// "ping <n>" on its serial port (D1 → through a 1 k / 2 k divider to the ESP32's RX2); every line
// that comes back on D0 (from the ESP32's TX2) is printed as "got <line>". Both at 115200 baud;
// the Uno's serial monitor shows both.
unsigned long last = 0;
unsigned int n = 0;
char line[32];
uint8_t length = 0;

void setup() {
  Serial.begin(115200);
}

void loop() {
  if (millis() - last >= 500) {
    last = millis();
    Serial.print("ping ");
    Serial.println(++n);
  }
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n') {
      line[length] = '\0';
      if (length > 0 && strncmp(line, "pong", 4) == 0) {
        Serial.print("got ");
        Serial.println(line);
      }
      length = 0;
    } else if (c != '\r' && length < sizeof line - 1) {
      line[length++] = c;
    }
  }
}
