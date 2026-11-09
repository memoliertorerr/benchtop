// rc-filter — tests assert (BT167): analogWrite(9, duty) (pin 9: 490 Hz PWM) through 10 kΩ into
// 10 µF to GND, the node on A0. The duty steps 64 → 128 → 192 every second; every 50 ms the sketch
// prints "pwm:<duty · 1023 / 255>,a0:<analogRead(A0)>" — two Serial Plotter series: the target and
// the filtered voltage climbing to it (RC = 0.1 s), with a few counts of ripple.
const int PWM = 9;
const uint8_t DUTIES[] = {64, 128, 192};

void setup() {
  Serial.begin(115200);
}

void loop() {
  uint8_t duty = DUTIES[(millis() / 1000) % 3];
  analogWrite(PWM, duty);
  Serial.print("pwm:");
  Serial.print((uint32_t)duty * 1023 / 255);
  Serial.print(",a0:");
  Serial.println(analogRead(A0));
  delay(50);
}
