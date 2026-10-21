// mega/timers — tests assert: analogWrite's 490 Hz (±1 %) PWM from timers 3, 4 and 1 — 25 % on
// D2 (OC3B, PE4), 50 % on D6 (OC4A, PH3), 75 % on D11 (OC1A, PB5) — and a Timer5 CTC compare
// interrupt at 1 kHz that toggles D22 (PA0) every 1 ms.
void setup() {
  analogWrite(2, 64);
  analogWrite(6, 128);
  analogWrite(11, 191);
  pinMode(22, OUTPUT);
  noInterrupts();
  TCCR5A = 0;
  TCCR5B = (1 << WGM52) | (1 << CS51) | (1 << CS50); // CTC on OCR5A, clk/64
  OCR5A = 249;                                       // 16 MHz / 64 / 250 = 1 kHz
  TIMSK5 = (1 << OCIE5A);
  interrupts();
}

ISR(TIMER5_COMPA_vect) {
  PINA = 1; // writing 1 to PINA0 toggles PA0 (D22)
}

void loop() {}
