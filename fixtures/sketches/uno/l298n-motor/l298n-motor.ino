// l298n-motor — tests assert (BT173, BT174): a DC motor on an L298N's channel A. ENA on 8 (its
// jumper off) enables the bridge; IN1 on 9 and IN2 on 10 are PWM pins. A pot on A0 sets the duty
// (0–255): forward PWMs IN1 with IN2 low, reverse PWMs IN2 with IN1 low, so between pulses both
// outputs are low and the bridge brakes the motor — its speed follows the duty. Below 10 the
// bridge is disabled and the motor coasts. A button on 2 (INPUT_PULLUP) reverses it: both INs low
// for 200 ms (brake), then the other way. Prints "fwd <duty>" / "rev <duty>" every 200 ms, "coast"
// instead while it coasts, and "brake" when it reverses.
const int ENA = 8;
const int IN1 = 9;
const int IN2 = 10;
const int BUTTON = 2;
bool forward = true;

void setup() {
  Serial.begin(115200);
  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
}

void loop() {
  static int last = HIGH;
  static uint32_t printed = 0;
  int button = digitalRead(BUTTON);
  if (last == HIGH && button == LOW) {
    digitalWrite(ENA, HIGH);
    digitalWrite(IN1, LOW);
    digitalWrite(IN2, LOW);
    Serial.println("brake");
    delay(200);
    forward = !forward;
  }
  last = button;
  int duty = analogRead(A0) / 4;
  bool coast = duty < 10;
  digitalWrite(ENA, coast ? LOW : HIGH);
  if (forward) {
    digitalWrite(IN2, LOW);
    analogWrite(IN1, duty);
  } else {
    digitalWrite(IN1, LOW);
    analogWrite(IN2, duty);
  }
  if (millis() - printed >= 200) {
    printed = millis();
    if (coast) {
      Serial.println("coast");
    } else {
      Serial.print(forward ? "fwd " : "rev ");
      Serial.println(duty);
    }
  }
  delay(10);
}
