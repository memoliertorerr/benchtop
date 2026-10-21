// gpio-interrupt — tests assert (BT34): attachInterrupt(4, FALLING) on a button from D4 (GPIO4)
// to GND (INPUT_PULLUP) counts presses; each new count prints as "count=<n>" on UART0, so five
// presses end with "count=5".
volatile uint32_t count = 0;
uint32_t shown = 0;

void IRAM_ATTR onPress() {
  count++;
}

void setup() {
  Serial.begin(115200);
  pinMode(4, INPUT_PULLUP);
  attachInterrupt(4, onPress, FALLING);
}

void loop() {
  if (count != shown) {
    shown = count;
    Serial.printf("count=%lu\n", (unsigned long)shown);
  }
  delay(5);
}
