// stepper-28byj48 — tests assert: a 28BYJ-48 on a ULN2003 (IN1..IN4 on D8..D11) driven by
// Stepper(2048, 8, 10, 9, 11) — Stepper.h wants the 28BYJ-48's coils as IN1, IN3, IN2, IN4.
// Setup first energizes Stepper's step-0 coils (IN1+IN2, one PORTB write) so the motor's
// reference matches the library's, then at setSpeed(15) runs step(512) (a quarter turn: 90°),
// prints "forward", waits 200 ms, runs step(-512) and prints "back" (115200 baud).
#include <Stepper.h>

Stepper motor(2048, 8, 10, 9, 11);

void setup() {
  Serial.begin(115200);
  PORTB |= _BV(0) | _BV(1);  // D8 and D9 together: IN1 + IN2
  delay(10);
  motor.setSpeed(15);
  motor.step(512);
  Serial.println(F("forward"));
  delay(200);
  motor.step(-512);
  Serial.println(F("back"));
}

void loop() {
}
