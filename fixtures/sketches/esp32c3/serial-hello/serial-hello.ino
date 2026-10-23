// serial-hello — tests assert (BT92): UART0 (GPIO21 TX) at 115200 baud prints "hello from esp32c3"
// once; loop() then counts on Serial once a second ("tick 1", "tick 2", …).
void setup() {
  Serial.begin(115200);
  Serial.println("hello from esp32c3");
}

void loop() {
  static int n = 0;
  delay(1000);
  Serial.printf("tick %d\n", ++n);
}
