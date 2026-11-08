// usb-midi (ESP32-S3) — tests assert (BT138), and the gallery's MIDI controller (BT139): built with
// the USB Mode "USB-OTG (TinyUSB)" and USB CDC On Boot (the `benchtop: usb-otg` line below), the
// S3's own USB is one device with a CDC-ACM port (`Serial`) and a USB-MIDI 1.0 interface. Arduino-
// ESP32 2.0.17 has no MIDI class, so the sketch adds TinyUSB's (its MIDI class driver is built
// in): `tinyusb_enable_interface` takes the interface's descriptors, registered from a global's
// constructor as Arduino's own USB classes do, before USB starts. Buttons to GND on IO4 and IO5
// (INPUT_PULLUP) play C4 (60) and E4 (64) on channel 1 while held, velocity 100; a pot on IO1
// sends control change 7 (volume) on channel 1 whenever its 7-bit value moves. Serial prints
// "usb midi ready" once the computer opens the port, then "sent <status> <data1> <data2>" in hex
// for each message.
// benchtop: usb-otg

#include "USB.h"
#include "esp32-hal-tinyusb.h"
#include "tusb.h"

static uint16_t midiDescriptor(uint8_t *dst, uint8_t *itf) {
  uint8_t name = tinyusb_add_string_descriptor("Benchtop MIDI");
  uint8_t epOut = tinyusb_get_free_out_endpoint();
  uint8_t epIn = tinyusb_get_free_in_endpoint();
  uint8_t descriptor[TUD_MIDI_DESC_LEN] = {TUD_MIDI_DESCRIPTOR(*itf, name, epOut, (uint8_t)(0x80 | epIn), 64)};
  *itf += 2;  // audio control + MIDI streaming
  memcpy(dst, descriptor, TUD_MIDI_DESC_LEN);
  return TUD_MIDI_DESC_LEN;
}

static struct MidiInterface {
  MidiInterface() { tinyusb_enable_interface(USB_INTERFACE_MIDI, TUD_MIDI_DESC_LEN, midiDescriptor); }
} midiInterface;

const int NOTE_PINS[] = {4, 5};
const uint8_t NOTES[] = {60, 64};
bool held[] = {false, false};
int volume = -1;

void send(uint8_t status, uint8_t a, uint8_t b) {
  uint8_t message[3] = {status, a, b};
  tud_midi_stream_write(0, message, 3);
  Serial.printf("sent %02x %02x %02x\n", status, a, b);
}

void setup() {
  for (int pin : NOTE_PINS) pinMode(pin, INPUT_PULLUP);
  USB.begin();
  Serial.begin(115200);
  while (!Serial) delay(10);
  Serial.println("usb midi ready");
}

void loop() {
  if (tud_midi_mounted()) {
    for (int i = 0; i < 2; i++) {
      bool down = digitalRead(NOTE_PINS[i]) == LOW;
      if (down != held[i]) {
        held[i] = down;
        if (down) send(0x90, NOTES[i], 100);
        else send(0x80, NOTES[i], 0);
      }
    }
    int value = analogRead(1) >> 5;  // 12 bits → 0..127
    if (value != volume) {
      volume = value;
      send(0xB0, 7, value);
    }
  }
  delay(10);
}
