// pcm-playback — tests assert (BT41): 8 kHz PCM — an 8-entry 1 kHz sine table — written into
// Timer2's 62.5 kHz fast PWM on D3 (OC2B) by a Timer1 compare interrupt (CTC, 16 MHz / 2000);
// a speaker on D3 reconstructs a 1 kHz tone: the PWM carrier filtered away, the sine kept.
const uint8_t SINE[8] = {128, 218, 255, 218, 128, 38, 1, 38};
volatile uint8_t phase = 0;

ISR(TIMER1_COMPA_vect) {
  OCR2B = SINE[phase++ & 7];
}

void setup() {
  pinMode(3, OUTPUT);
  // Timer2: fast PWM (WGM 3), non-inverting on OC2B, no prescaler: 16 MHz / 256 = 62.5 kHz.
  TCCR2A = _BV(COM2B1) | _BV(WGM21) | _BV(WGM20);
  TCCR2B = _BV(CS20);
  OCR2B = 128;
  // Timer1: CTC (WGM 4) on OCR1A, no prescaler: 16 MHz / 2000 = 8 kHz.
  cli();
  TCCR1A = 0;
  TCCR1B = _BV(WGM12) | _BV(CS10);
  OCR1A = 1999;
  TIMSK1 = _BV(OCIE1A);
  sei();
}

void loop() {
}
