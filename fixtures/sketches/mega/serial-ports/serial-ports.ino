// mega/serial-ports — tests assert: all four USARTs at 115200 baud. With Serial1–3 each looped
// back (TX1 D18 → RX1 D19, TX2 D16 → RX2 D17, TX3 D14 → RX3 D15), the sketch writes '1', '2', '3'
// on them at startup and once a second after, and Serial (USART0) prints what each port heard:
// "S1 1", "S2 2", "S3 3".
unsigned long last;

void send() {
  Serial1.write('1');
  Serial2.write('2');
  Serial3.write('3');
}

void echo(HardwareSerial &port, const char *name) {
  while (port.available()) {
    Serial.print(name);
    Serial.print(' ');
    Serial.println((char)port.read());
  }
}

void setup() {
  Serial.begin(115200);
  Serial1.begin(115200);
  Serial2.begin(115200);
  Serial3.begin(115200);
  Serial.println("ports");
  send();
  last = millis();
}

void loop() {
  if (millis() - last >= 1000) {
    last += 1000;
    send();
  }
  echo(Serial1, "S1");
  echo(Serial2, "S2");
  echo(Serial3, "S3");
}
