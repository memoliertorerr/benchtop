// Pico 2 serial hello (BT65): on the RP2350's RISC-V cores, "uart0 <n>" on UART0 (Serial1,
// GP0/GP1) and "uart1 <n>" on UART1 (Serial2, GP4/GP5) at 115200, once a second; "hello from
// pico 2 <n>" on USB serial too (Serial; BT66 brings USB).
int count = 0;

void setup() {
  Serial.begin(115200);
  Serial1.begin(115200);
  Serial2.setTX(4);
  Serial2.setRX(5);
  Serial2.begin(115200);
}

void loop() {
  Serial.print("hello from pico 2 ");
  Serial.println(count);
  Serial1.print("uart0 ");
  Serial1.println(count);
  Serial2.print("uart1 ");
  Serial2.println(count);
  count++;
  delay(1000);
}
