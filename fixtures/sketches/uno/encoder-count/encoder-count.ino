// encoder-count — tests assert: a KY-040 with CLK on D2, DT on D3 and SW on D4 (all
// INPUT_PULLUP). On each falling edge of CLK the count goes up when DT is high (clockwise: CLK
// falls first) and down when DT is low; every change prints "count=<n>" at 115200 baud. A press
// of the shaft (D4 falling) prints "SW". The pins are polled, so each detent counts exactly once.
int count = 0;
uint8_t lastClk = HIGH;
uint8_t lastSw = HIGH;

void setup() {
  Serial.begin(115200);
  pinMode(2, INPUT_PULLUP);
  pinMode(3, INPUT_PULLUP);
  pinMode(4, INPUT_PULLUP);
}

void loop() {
  uint8_t clk = digitalRead(2);
  if (lastClk == HIGH && clk == LOW) {
    count += digitalRead(3) == HIGH ? 1 : -1;
    Serial.print(F("count="));
    Serial.println(count);
  }
  lastClk = clk;
  uint8_t sw = digitalRead(4);
  if (lastSw == HIGH && sw == LOW) Serial.println(F("SW"));
  lastSw = sw;
}
