// servo-sweep — tests assert: Servo on D9 is written 0, 5, …, 180, 175, …, 0 (5° steps, one
// every 20 ms), each angle printed on its own line at 115200 baud before its wait; then "done".
// Servo.h maps an angle to 544 + angle·1856/180 µs pulses every 20 ms. Its first pulse comes
// ~50 ms after attach() (Timer1 must wrap first, on hardware too), so 0° is held for 100 ms
// before the sweep starts.
#include <Servo.h>

Servo servo;

void sweepTo(int angle) {
  servo.write(angle);
  Serial.println(angle);
  delay(20);
}

void setup() {
  Serial.begin(115200);
  servo.attach(9);
  servo.write(0);
  Serial.println(0);
  delay(100);
  for (int a = 5; a <= 180; a += 5) sweepTo(a);
  for (int a = 175; a >= 0; a -= 5) sweepTo(a);
  Serial.println(F("done"));
}

void loop() {
}
