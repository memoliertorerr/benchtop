// inputs-report — tests assert: every 50 ms UART0 (115200 baud) prints one line
// "A0=<n> A1=<n> A2=<n> A3=<n> A4=<n> A5=<n> D=<8 chars>", the analogRead() of A0..A5 and the
// digitalRead() of D2..D9 (D2 first) as '0'/'1'. D2..D9 are INPUT_PULLUP.
unsigned long next = 0;

void setup() {
  Serial.begin(115200);
  for (uint8_t pin = 2; pin <= 9; pin++) pinMode(pin, INPUT_PULLUP);
}

void loop() {
  if (millis() < next) return;
  next += 50;
  for (uint8_t i = 0; i < 6; i++) {
    if (i > 0) Serial.print(' ');
    Serial.print('A');
    Serial.print(i);
    Serial.print('=');
    Serial.print(analogRead(A0 + i));
  }
  Serial.print(F(" D="));
  for (uint8_t pin = 2; pin <= 9; pin++) Serial.print(digitalRead(pin) ? '1' : '0');
  Serial.println();
}
