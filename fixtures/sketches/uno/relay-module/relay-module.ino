// relay-module — tests assert: a 1-channel relay module (active low) with IN on pin 7, COM on 5V,
// a lamp (an LED and 220 Ohm) on NO and another on NC. First a 3 ms pulse on IN, shorter than the
// relay's operate time ("blip": the contacts don't move); then every 500 ms from 200 ms it switches
// the relay, printing "on" or "off" at 115200 baud.

const int IN = 7;

void setup() {
  Serial.begin(115200);
  pinMode(IN, OUTPUT);
  digitalWrite(IN, HIGH);  // off: the module is active low
  delay(50);
  digitalWrite(IN, LOW);
  delay(3);
  digitalWrite(IN, HIGH);
  Serial.println("blip");
  delay(150);
}

bool on = false;

void loop() {
  on = !on;
  digitalWrite(IN, on ? LOW : HIGH);
  Serial.println(on ? "on" : "off");
  delay(500);
}
