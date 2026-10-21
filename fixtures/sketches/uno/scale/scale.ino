// scale — tests assert (BT52): an HX711 load-cell ADC (DT D3, SCK D2) read by a sketch-local
// shift-in — wait for DT low, 24 SCK pulses MSB first, a 25th for channel A × 128 next — tares
// on its first reading, then prints the weight every 500 ms as "g=<grams>" with one decimal at
// 100 counts a gram (the module's default calibration), at 115200 baud.
const uint8_t HX_DT = 3, HX_SCK = 2;
long tare = 0;

long readHx711() {
  while (digitalRead(HX_DT) == HIGH) {
  }
  long value = 0;
  noInterrupts();
  for (uint8_t i = 0; i < 24; i++) {
    digitalWrite(HX_SCK, HIGH);
    delayMicroseconds(1);
    value = (value << 1) | digitalRead(HX_DT);
    digitalWrite(HX_SCK, LOW);
    delayMicroseconds(1);
  }
  digitalWrite(HX_SCK, HIGH); // 25th pulse: channel A, gain 128
  delayMicroseconds(1);
  digitalWrite(HX_SCK, LOW);
  interrupts();
  if (value & 0x800000) value |= 0xFF000000; // sign-extend 24 bits
  return value;
}

void setup() {
  Serial.begin(115200);
  pinMode(HX_DT, INPUT);
  pinMode(HX_SCK, OUTPUT);
  digitalWrite(HX_SCK, LOW);
  tare = readHx711();
  Serial.println("tared");
}

void loop() {
  long counts = readHx711() - tare;
  Serial.print("g=");
  Serial.println(counts / 100.0, 1);
  delay(500);
}
