// l298n-stepper — tests assert (BT173): a bipolar stepper (200 steps a turn) on an L298N, coil A on
// OUT1/OUT2 and coil B on OUT3/OUT4, IN1–IN4 on 8–11 (both enable jumpers on), driven by the
// Stepper library at 60 rpm: one turn forward, "turned", one turn back, "back", forever.
#include <Stepper.h>

Stepper stepper(200, 8, 9, 10, 11);

void setup() {
  Serial.begin(115200);
  stepper.setSpeed(60);
}

void loop() {
  stepper.step(200);
  Serial.println("turned");
  stepper.step(-200);
  Serial.println("back");
}
