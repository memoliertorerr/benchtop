// gpio-interrupt — tests assert (BT149): a button from GPIO41 to GND with INPUT_PULLUP;
// attachInterrupt(41, FALLING) counts presses and each new count prints as "count=<n>" on UART0,
// so five presses end with "count=5". The LED on GPIO38 follows the button: on within 2 ms of a
// press, off within 2 ms of the release. Both pins are in the S2's second GPIO word (32–46).
volatile uint32_t count = 0;
uint32_t shown = 0;

void IRAM_ATTR onPress() {
  count++;
}

void setup() {
  Serial.begin(115200);
  pinMode(41, INPUT_PULLUP);
  pinMode(38, OUTPUT);
  attachInterrupt(41, onPress, FALLING);
}

void loop() {
  digitalWrite(38, digitalRead(41) == LOW ? HIGH : LOW);
  if (count != shown) {
    shown = count;
    Serial.printf("count=%lu\n", (unsigned long)shown);
  }
  delay(1);
}
