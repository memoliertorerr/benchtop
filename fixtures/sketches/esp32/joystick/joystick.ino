// joystick — tests assert (BT165): an analog joystick on ADC2's pins — HORZ on GPIO25 (ADC2
// channel 8), VERT on GPIO26 (channel 9), SEL on GPIO27 (INPUT_PULLUP: low while pressed). Every
// 50 ms it prints "x:<0–4095>,y:<0–4095>" — two series for the Serial Plotter — and the onboard
// LED (GPIO2) lights while the stick is pressed. ADC2 reads work while WiFi is off (a sketch that
// starts WiFi reads 0 there, as on a board).
const int HORZ = 25;
const int VERT = 26;
const int SEL = 27;
const int LED = 2;

void setup() {
  Serial.begin(115200);
  pinMode(SEL, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
}

void loop() {
  int x = analogRead(HORZ);
  int y = analogRead(VERT);
  digitalWrite(LED, digitalRead(SEL) == LOW ? HIGH : LOW);
  Serial.printf("x:%d,y:%d\n", x, y);
  delay(50);
}
