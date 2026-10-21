// stepper-bipolar — tests assert: a 200-step bipolar motor behind an H-bridge with A+, A-, B+, B-
// on D8..D11. Setup energizes Stepper's step-0 state (A+ and B+, one PORTB write) as the
// reference, runs Stepper(200, 8, 9, 10, 11) at setSpeed(60) for step(50) (90°), prints "full",
// waits 100 ms, then drives 100 half-steps from a sketch-local 8-state table, 5 ms apart (another 90°), and
// prints "half" (115200 baud).
#include <Stepper.h>

Stepper motor(200, 8, 9, 10, 11);

// Coil states for electrical positions 0..7: A then B direction (+1, 0, -1).
const int8_t A[8] = {1, 1, 0, -1, -1, -1, 0, 1};
const int8_t B[8] = {0, 1, 1, 1, 0, -1, -1, -1};

void setup() {
  Serial.begin(115200);
  PORTB |= _BV(0) | _BV(2);  // D8 (A+) and D10 (B+) together
  delay(10);
  motor.setSpeed(60);
  motor.step(50);
  Serial.println(F("full"));
  delay(100);
  // step(50) ended on Stepper's state 2 (A-, B-): electrical position 5.
  uint8_t position = 5;
  for (uint8_t k = 0; k < 100; k++) {
    position = (position + 1) & 7;
    digitalWrite(8, A[position] > 0);
    digitalWrite(9, A[position] < 0);
    digitalWrite(10, B[position] > 0);
    digitalWrite(11, B[position] < 0);
    delay(5);
  }
  Serial.println(F("half"));
}

void loop() {
}
