// usb-rgb (ESP32-S3) — the gallery's USB-OTG example (BT135): `Serial` is TinyUSB's CDC port on the
// S3's own USB (the board menu's USB Mode "USB-OTG (TinyUSB)" with USB CDC On Boot — the
// `benchtop: usb-otg` line below asks Benchtop's compile for both). Once the computer opens the
// port it prints "usb serial ready: type red, green, blue, white or off"; each line typed sets the
// DevKitC-1's RGB LED (a WS2812 on GPIO48, neopixelWrite) and answers "led <color>", or
// "unknown <line>".
// benchtop: usb-otg

static String line;

void show(const String &color) {
  if (color == "red") neopixelWrite(RGB_BUILTIN, 255, 0, 0);
  else if (color == "green") neopixelWrite(RGB_BUILTIN, 0, 255, 0);
  else if (color == "blue") neopixelWrite(RGB_BUILTIN, 0, 0, 255);
  else if (color == "white") neopixelWrite(RGB_BUILTIN, 64, 64, 64);
  else if (color == "off") neopixelWrite(RGB_BUILTIN, 0, 0, 0);
  else {
    Serial.printf("unknown %s\n", color.c_str());
    return;
  }
  Serial.printf("led %s\n", color.c_str());
}

void setup() {
  neopixelWrite(RGB_BUILTIN, 0, 0, 0);
  Serial.begin(115200);
  while (!Serial) delay(10);
  Serial.println("usb serial ready: type red, green, blue, white or off");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      line.trim();
      line.toLowerCase();
      if (line.length() > 0) show(line);
      line = "";
    } else {
      line += c;
    }
  }
  delay(2);
}
