// serial-hello — tests assert (BT27 parses it; BT32's boot milestone runs it): UART0 at 115200
// baud prints "hello from esp32" once; loop() then waits 1 s at a time, forever.
void setup() {
  Serial.begin(115200);
  Serial.println("hello from esp32");
}

void loop() {
  delay(1000);
}
