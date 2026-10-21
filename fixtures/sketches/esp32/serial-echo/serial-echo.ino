// serial-echo — tests assert (BT35): each line received on Serial (UART0, 115200) comes back
// uppercased as "> <LINE>\r\n" ("abc\n" → "> ABC\r\n"; a 200-byte line arrives intact), and
// Serial2 (UART2 on GPIO16 RX / GPIO17 TX through the GPIO matrix) does the same. Prints
// "ready" once both ports are open.
String line0;
String line2;

void echo(Stream &port, String &line) {
  while (port.available() > 0) {
    char c = (char)port.read();
    if (c == '\n') {
      line.toUpperCase();
      port.print("> ");
      port.print(line);
      port.print("\r\n");
      line = "";
    } else if (c != '\r') {
      line += c;
    }
  }
}

void setup() {
  Serial.begin(115200);
  Serial2.begin(115200);
  line0.reserve(256);
  line2.reserve(256);
  Serial.println("ready");
}

void loop() {
  echo(Serial, line0);
  echo(Serial2, line2);
  delay(1);
}
