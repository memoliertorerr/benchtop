// shift-register — tests assert: an 8-LED binary counter on a 74HC595, as Arduino's ShiftOut
// tutorial wires it (DS on 11, SHCP on 12, STCP — the latch — on 8). Every 100 ms it shifts the
// next count out MSB first (so Q7 is 128), latches it and prints "q=<n>" at 115200 baud.

const int latchPin = 8;
const int clockPin = 12;
const int dataPin = 11;

void setup() {
  pinMode(latchPin, OUTPUT);
  pinMode(clockPin, OUTPUT);
  pinMode(dataPin, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  for (int n = 0; n < 256; n++) {
    digitalWrite(latchPin, LOW);
    shiftOut(dataPin, clockPin, MSBFIRST, n);
    digitalWrite(latchPin, HIGH);
    Serial.print("q=");
    Serial.println(n);
    delay(100);
  }
}
