// servo-knob — tests assert (BT43): a potentiometer on A0 steers a servo on D9: the knob's
// reading 0…1023 maps to 0…180°, updated every 15 ms. Turn the knob in the Inspector while it
// runs.
#include <Servo.h>

Servo servo;

void setup() {
  servo.attach(9);
}

void loop() {
  int reading = analogRead(A0);                  // 0 … 1023
  servo.write(map(reading, 0, 1023, 0, 180));   // 0 … 180 degrees
  delay(15);
}
