// usb-cdc (ESP32-S2) — tests assert (BT149): built with the board menu's USB CDC On Boot "Enabled",
// so `Serial` is TinyUSB's CDC-ACM port on the S2's own USB (the USB-OTG controller, its only USB),
// not UART0. Once the host has opened the port (DTR set), prints "usb cdc up baud <the host's line
// coding>", then every 500 ms "tick <n>", and echoes each line it receives as "echo <line>". UART0
// (Serial0) says "uart0 here" once, at 115200 baud.
void setup() {
  Serial0.begin(115200);
  Serial0.println("uart0 here");
  Serial.begin(115200);
  while (!Serial) delay(10);
  Serial.printf("usb cdc up baud %u\n", (unsigned)Serial.baudRate());
}

static String line;
static uint32_t n = 0;
static uint32_t last = 0;

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      Serial.printf("echo %s\n", line.c_str());
      line = "";
    } else if (c != '\r') {
      line += c;
    }
  }
  if (millis() - last >= 500) {
    last = millis();
    Serial.printf("tick %u\n", (unsigned)n++);
  }
  delay(1);
}
