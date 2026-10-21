// pwm-fade — tests assert: analogWrite(9, v) (Timer1 PWM on PB1) with v stepping 0 → 255 → 0
// by 1 every 10 ms, so the duty measured over 20 ms rises across the first 2.55 s.
int value = 0;
int step = 1;

void setup() {
  pinMode(9, OUTPUT);
}

void loop() {
  analogWrite(9, value);
  value += step;
  if (value == 255 || value == 0) step = -step;
  delay(10);
}
