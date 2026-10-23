// gpio-interrupt — tests assert (BT93): a button from GPIO9 (the DevKitM-1's BOOT button) to GND
// with INPUT_PULLUP; attachInterrupt(9, FALLING) counts presses and each new count prints as
// "count=<n>" on UART0, so five presses end with "count=5". The LED on GPIO3 follows the button:
// on within 2 ms of a press, off within 2 ms of the release.
volatile uint32_t count = 0;
uint32_t shown = 0;

void IRAM_ATTR onPress() {
  count++;
}

void setup() {
  Serial.begin(115200);
  pinMode(9, INPUT_PULLUP);
  pinMode(3, OUTPUT);
  attachInterrupt(9, onPress, FALLING);
}

void loop() {
  digitalWrite(3, digitalRead(9) == LOW ? HIGH : LOW);
  if (count != shown) {
    shown = count;
    Serial.printf("count=%lu\n", (unsigned long)shown);
  }
  delay(1);
}
