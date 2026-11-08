// usb-keys (ESP32-S3) — tests assert (BT138), and the gallery's macro keypad (BT139): built with
// the USB Mode "USB-OTG (TinyUSB)" and USB CDC On Boot (the `benchtop: usb-otg` line below), the
// S3's own USB is one device with a CDC-ACM port (`Serial`) and a HID interface carrying a
// keyboard, a mouse and media keys (Arduino's USB library). Buttons to GND, INPUT_PULLUP:
//   IO4 types "Hello from Benchtop!" and Enter (Keyboard.println: Shift for the capitals and "!");
//   IO5 moves the mouse by (+20, -10), clicks the left button and scrolls one notch up;
//   IO6 presses Volume Up (ConsumerControl), held 20 ms.
// Serial prints "usb keys ready" once the computer opens the port, then "typed", "mouse" or
// "volume up" after each press.
// benchtop: usb-otg

#include "USB.h"
#include "USBHIDKeyboard.h"
#include "USBHIDMouse.h"
#include "USBHIDConsumerControl.h"

USBHIDKeyboard Keyboard;
USBHIDMouse Mouse;
USBHIDConsumerControl ConsumerControl;

const int PINS[] = {4, 5, 6};
bool released[] = {true, true, true};

void setup() {
  for (int pin : PINS) pinMode(pin, INPUT_PULLUP);
  Keyboard.begin();
  Mouse.begin();
  ConsumerControl.begin();
  USB.begin();
  Serial.begin(115200);
  while (!Serial) delay(10);
  Serial.println("usb keys ready");
}

void loop() {
  for (int i = 0; i < 3; i++) {
    bool up = digitalRead(PINS[i]) == HIGH;
    if (released[i] && !up) {
      if (i == 0) {
        Keyboard.println("Hello from Benchtop!");
        Serial.println("typed");
      } else if (i == 1) {
        Mouse.move(20, -10);
        Mouse.click(MOUSE_LEFT);
        Mouse.move(0, 0, 1);
        Serial.println("mouse");
      } else {
        ConsumerControl.press(CONSUMER_CONTROL_VOLUME_INCREMENT);
        delay(20);
        ConsumerControl.release();
        Serial.println("volume up");
      }
    }
    released[i] = up;
  }
  delay(10);
}
