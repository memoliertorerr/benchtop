// neopixel — tests assert: 24 WS2812 pixels on D6 (an 8-pixel strip whose DOUT feeds a 16-pixel
// ring) get pixel i = (r, g, b) = ((i*37 + 16) & 255, (255 - i*9) & 255, (i*73) & 255), sent
// GRB, MSB first, by a sketch-local bit-bang (Adafruit_NeoPixel isn't installed and isn't copied):
// 20 cycles per bit at 16 MHz, the line high for 6 cycles (375 ns) for a 0 and 12 cycles
// (750 ns) for a 1, interrupts off during the frame. Then "sent" at 115200 baud; the frame is
// resent every 500 ms.
const uint8_t PIXELS = 24;
uint8_t grb[PIXELS * 3];

void show(const uint8_t *data, uint16_t count) {
  const uint8_t hi = PORTD | _BV(6);
  const uint8_t lo = PORTD & ~_BV(6);
  uint8_t value;
  uint8_t bits;
  const uint8_t sreg = SREG;
  cli();
  asm volatile(
      "1:                        \n\t"
      "ld   %[value], %a[ptr]+   \n\t"
      "ldi  %[bits], 8           \n\t"
      "2:                        \n\t"
      "out  %[port], %[hi]       \n\t"  // 1  rise
      "rjmp .+0                  \n\t"  // 2
      "rjmp .+0                  \n\t"  // 2
      "sbrs %[value], 7          \n\t"  // 1, or 2 skipping for a 1 bit
      "out  %[port], %[lo]       \n\t"  // 1  a 0 bit falls 6 cycles after the rise
      "lsl  %[value]             \n\t"  // 1
      "rjmp .+0                  \n\t"  // 2
      "rjmp .+0                  \n\t"  // 2
      "out  %[port], %[lo]       \n\t"  // 1  a 1 bit falls 12 cycles after the rise
      "dec  %[bits]              \n\t"  // 1
      "breq 3f                   \n\t"  // 1 (2 when the byte is done)
      "rjmp .+0                  \n\t"  // 2
      "nop                       \n\t"  // 1
      "rjmp 2b                   \n\t"  // 2  = 20 cycles per bit
      "3:                        \n\t"
      "sbiw %[count], 1          \n\t"
      "brne 1b                   \n\t"
      : [value] "=&d"(value), [bits] "=&d"(bits), [ptr] "+e"(data), [count] "+w"(count)
      : [port] "I"(_SFR_IO_ADDR(PORTD)), [hi] "r"(hi), [lo] "r"(lo));
  SREG = sreg;
}

void setup() {
  Serial.begin(115200);
  pinMode(6, OUTPUT);
  digitalWrite(6, LOW);
  for (uint8_t i = 0; i < PIXELS; i++) {
    grb[i * 3] = (255 - i * 9) & 255;
    grb[i * 3 + 1] = (i * 37 + 16) & 255;
    grb[i * 3 + 2] = (i * 73) & 255;
  }
  delay(1);
  show(grb, sizeof grb);
  Serial.println(F("sent"));
}

void loop() {
  delay(500);
  show(grb, sizeof grb);
}
