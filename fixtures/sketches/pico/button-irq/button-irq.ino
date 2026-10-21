// button-irq — tests assert (BT61): a pushbutton from GP14 to GND with the internal pull-up;
// attachInterrupt on the falling edge counts presses, and loop() prints "presses=<n>" on USB
// serial whenever the count changes.
volatile int presses = 0;
int shown = -1;

void onPress() {
  presses++;
}

void setup() {
  Serial.begin(115200);
  pinMode(14, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(14), onPress, FALLING);
}

void loop() {
  int now = presses;
  if (now != shown) {
    shown = now;
    Serial.print("presses=");
    Serial.println(now);
  }
  delay(10);
}
