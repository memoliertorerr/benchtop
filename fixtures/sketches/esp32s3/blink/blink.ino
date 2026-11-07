// blink — tests assert (BT124 boots it; BT125 times it): GPIO2 toggles every 500 ms.
const int LED = 2;

void setup() {
  pinMode(LED, OUTPUT);
}

void loop() {
  digitalWrite(LED, HIGH);
  delay(500);
  digitalWrite(LED, LOW);
  delay(500);
}
