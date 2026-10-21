// timer1-ctc — tests assert: raw registers put Timer1 in CTC mode at 1 kHz (clk/8 = 2 MHz,
// OCR1A = 1999) and the compare ISR toggles D12 (PB4): 1000 toggles per second, ±0.1%.
void setup() {
  pinMode(12, OUTPUT);
  noInterrupts();
  TCCR1A = 0;
  TCCR1B = _BV(WGM12) | _BV(CS11);
  OCR1A = 1999;
  TCNT1 = 0;
  TIMSK1 = _BV(OCIE1A);
  interrupts();
}

ISR(TIMER1_COMPA_vect) {
  PORTB ^= _BV(PORTB4);
}

void loop() {
}
