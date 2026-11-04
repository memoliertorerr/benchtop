// prefs-led — tests assert (BT120): the gallery's Preferences example. The LED on D2 (GPIO2)
// remembers its state across resets: a press of the button on D4 (GPIO4, to GND, INPUT_PULLUP)
// toggles it and stores the state with Preferences (namespace "led", key "on"); at start the LED
// shows the stored state. Prints "start: led on|off" at start and "led on|off" at each toggle,
// at 115200 baud.
#include <Preferences.h>

const int LED = 2;
const int BUTTON = 4;
Preferences prefs;
bool on = false;
bool wasPressed = false;

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
  prefs.begin("led", false);
  on = prefs.getBool("on", false);
  digitalWrite(LED, on ? HIGH : LOW);
  Serial.printf("start: led %s\n", on ? "on" : "off");
}

void loop() {
  bool pressed = digitalRead(BUTTON) == LOW;
  if (pressed && !wasPressed) {
    on = !on;
    digitalWrite(LED, on ? HIGH : LOW);
    prefs.putBool("on", on);
    Serial.printf("led %s\n", on ? "on" : "off");
  }
  wasPressed = pressed;
  delay(20);
}
