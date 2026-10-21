// uart-chat — tests assert (BT43): the ESP32 half of a two-board chat. Serial2 (RX2 = GPIO16,
// TX2 = GPIO17, 115200 baud) answers each "ping <n>" line from the Uno with "pong <n>", and logs
// both on its own serial monitor (UART0).
String line;

void setup() {
  Serial.begin(115200);
  Serial2.begin(115200, SERIAL_8N1, 16, 17);
  Serial.println("listening");
}

void loop() {
  while (Serial2.available() > 0) {
    char c = Serial2.read();
    if (c == '\n') {
      line.trim();
      if (line.startsWith("ping ")) {
        String reply = "pong " + line.substring(5);
        Serial2.println(reply);
        Serial.println(line + " -> " + reply);
      }
      line = "";
    } else {
      line += c;
    }
  }
  delay(1);
}
