// logic-demo — tests assert, with probes on D3, D9 and D7:
// - D3: SoftwareSerial TX at 9600 baud sending 'U' (0x55, so every bit is an edge): each bit
//   lasts 104.17 µs (±2). One byte goes out right after every rising edge of D7, i.e. every 2 ms
//   (a byte takes 1.04 ms with interrupts off, so back-to-back sends would starve the D7 clock).
// - D9: analogWrite(9, 64) — Timer1 8-bit phase-correct PWM at 490.2 Hz: period 2040.8 µs (±2),
//   high time 512 µs (±5).
// - D7: toggled every 1000 µs from micros() with a fixed schedule (next += 1000): rising edge
//   to rising edge 2.000 ms (±0.01).
#include <SoftwareSerial.h>

SoftwareSerial soft(2, 3); // RX D2 (unused), TX D3

unsigned long next;
bool high = false;

void setup() {
  soft.begin(9600);
  analogWrite(9, 64);
  pinMode(7, OUTPUT);
  next = micros() + 1000;
}

void loop() {
  if ((long)(micros() - next) < 0) return;
  next += 1000;
  high = !high;
  digitalWrite(7, high ? HIGH : LOW);
  if (high) soft.write('U');
}
