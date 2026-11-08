// usb-locks (ESP32-S3) — tests assert (BT145): built with the USB Mode "USB-OTG (TinyUSB)" and USB
// CDC On Boot (the `benchtop: usb-otg` line below), the S3's own USB is one device with a CDC-ACM
// port (`Serial`) and a keyboard (Arduino's USBHIDKeyboard). The computer sends a keyboard the
// state of its lock keys as an output report — the LEDs a keyboard lights — whenever it changes;
// Arduino posts it as ARDUINO_USB_HID_KEYBOARD_LED_EVENT.
//   Serial prints "usb locks ready" once the computer opens the port, then "leds num <0|1> caps
//   <0|1> scroll <0|1>" for each report; the RGB LED (a WS2812 on GPIO48) shows them — red Caps
//   Lock, green Num Lock, blue Scroll Lock.
//   A button to GND on IO4 (INPUT_PULLUP) types "a"; one on IO5 presses the keyboard's own Caps
//   Lock key, which the computer answers with a new report.
// benchtop: usb-otg

#include "USB.h"
#include "USBHIDKeyboard.h"

USBHIDKeyboard Keyboard;

const int TYPE_PIN = 4;
const int CAPS_PIN = 5;
volatile uint8_t leds = 0;
volatile bool changed = false;
bool typeHeld = false;
bool capsHeld = false;

static void onKeyboard(void *, esp_event_base_t base, int32_t id, void *data) {
  if (base == ARDUINO_USB_HID_KEYBOARD_EVENTS && id == ARDUINO_USB_HID_KEYBOARD_LED_EVENT) {
    leds = ((arduino_usb_hid_keyboard_event_data_t *)data)->leds;
    changed = true;
  }
}

void setup() {
  pinMode(TYPE_PIN, INPUT_PULLUP);
  pinMode(CAPS_PIN, INPUT_PULLUP);
  Keyboard.onEvent(onKeyboard);
  Keyboard.begin();
  USB.begin();
  Serial.begin(115200);
  while (!Serial) delay(10);
  Serial.println("usb locks ready");
}

void loop() {
  if (changed) {
    changed = false;
    uint8_t l = leds;
    Serial.printf("leds num %d caps %d scroll %d\n", l & 1, (l >> 1) & 1, (l >> 2) & 1);
    neopixelWrite(RGB_BUILTIN, (l & 2) ? 255 : 0, (l & 1) ? 255 : 0, (l & 4) ? 255 : 0);
  }
  bool typing = digitalRead(TYPE_PIN) == LOW;
  if (typing && !typeHeld) Keyboard.write('a');
  typeHeld = typing;
  bool caps = digitalRead(CAPS_PIN) == LOW;
  if (caps && !capsHeld) {
    Keyboard.press(KEY_CAPS_LOCK);
    delay(20);
    Keyboard.release(KEY_CAPS_LOCK);
  }
  capsHeld = caps;
  delay(10);
}
