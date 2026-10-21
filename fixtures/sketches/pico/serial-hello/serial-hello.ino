// Pico serial hello (BT60): "hello from pico" on USB serial (Serial), then on UART0 (Serial1,
// GP0/GP1) and UART1 (Serial2, GP4/GP5) at 115200, once a second with a counter.
int count = 0;

void setup() {
  Serial.begin(115200);
  Serial1.begin(115200);
  Serial2.setTX(4);
  Serial2.setRX(5);
  Serial2.begin(115200);
}

void loop() {
  Serial.print("hello from pico ");
  Serial.println(count);
  Serial1.print("uart0 ");
  Serial1.println(count);
  Serial2.print("uart1 ");
  Serial2.println(count);
  count++;
  delay(1000);
}
