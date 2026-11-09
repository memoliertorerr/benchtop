// serial-hello — tests assert (BT148): UART0 (GPIO43 TX) at 115200 baud prints "hello from esp32s2"
// once; loop() then counts on Serial once a second ("tick 1", "tick 2", …).
void setup() {
  Serial.begin(115200);
  Serial.println("hello from esp32s2");
}

void loop() {
  static int n = 0;
  delay(1000);
  Serial.printf("tick %d\n", ++n);
}
