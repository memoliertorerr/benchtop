// blink — tests assert (BT148 boots it; BT149 times it): GPIO2 toggles every 500 ms.
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
