// cdc-hello — tests assert (BT93): built with USB CDC on boot (FQBN option CDCOnBoot=cdc), so
// Serial is the C3's USB-Serial-JTAG: prints "hello over usb" once, then "tick N" once a second;
// each line received on Serial comes back as "> <line>".
String line;

void setup() {
  Serial.begin(115200);
  Serial.println("hello over usb");
}

void loop() {
  static int n = 0;
  static unsigned long last = millis();
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n') {
      Serial.print("> ");
      Serial.println(line);
      line = "";
    } else if (c != '\r') {
      line += c;
    }
  }
  if (millis() - last >= 1000) {
    last += 1000;
    Serial.printf("tick %d\n", ++n);
  }
  delay(1);
}
