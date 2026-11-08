// usb-synth (ESP32-S3) — tests assert (BT145), and the gallery's USB MIDI synth (BT146): built
// with the USB Mode "USB-OTG (TinyUSB)" and USB CDC On Boot (the `benchtop: usb-otg` line below),
// the S3's own USB is one device with a CDC-ACM port (`Serial`) and a USB-MIDI 1.0 interface
// (TinyUSB's MIDI class, added as in usb-midi). It plays what the computer sends it: the last
// note held sounds as a square wave on IO5 (LEDC, equal temperament, A4 = 440 Hz) for a speaker
// or buzzer, and the RGB LED (a WS2812 on GPIO48) takes a color per note name, brighter with the
// velocity; a note off of that note, or all notes off (control change 123), stops it.
// Serial prints "usb synth ready" once the computer opens the port, then "note on <n> <velocity>",
// "note off <n>", "cc <controller> <value>", "sysex <bytes in hex>" and "midi <bytes in hex>" for
// anything else.
// benchtop: usb-otg

#include "USB.h"
#include "esp32-hal-tinyusb.h"
#include "tusb.h"

static uint16_t midiDescriptor(uint8_t *dst, uint8_t *itf) {
  uint8_t name = tinyusb_add_string_descriptor("Benchtop Synth");
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

const int SPEAKER_PIN = 5;
const int CHANNEL = 0;
// A color per note name, C to B.
const uint8_t COLORS[12][3] = {{255, 0, 0}, {255, 64, 0}, {255, 128, 0}, {255, 192, 0}, {255, 255, 0}, {0, 255, 0},
                               {0, 255, 128}, {0, 255, 255}, {0, 128, 255}, {0, 0, 255}, {128, 0, 255}, {255, 0, 255}};
int playing = -1;
uint8_t sysex[64];
int sysexLength = 0;

void play(int note, int velocity) {
  playing = note;
  double hz = 440.0 * pow(2.0, (note - 69) / 12.0);
  ledcWriteTone(CHANNEL, (uint32_t)(hz + 0.5));
  int level = velocity * 2;
  neopixelWrite(RGB_BUILTIN, COLORS[note % 12][0] * level / 255, COLORS[note % 12][1] * level / 255, COLORS[note % 12][2] * level / 255);
}

void silence() {
  playing = -1;
  ledcWriteTone(CHANNEL, 0);
  neopixelWrite(RGB_BUILTIN, 0, 0, 0);
}

void message(uint8_t cin, const uint8_t *m) {
  uint8_t status = m[0] & 0xf0;
  if (cin == 0x9 && m[2] > 0) {
    Serial.printf("note on %d %d\n", m[1], m[2]);
    play(m[1], m[2]);
  } else if (cin == 0x8 || cin == 0x9) {
    Serial.printf("note off %d\n", m[1]);
    if (m[1] == playing) silence();
  } else if (cin == 0xb) {
    Serial.printf("cc %d %d\n", m[1], m[2]);
    if (m[1] == 123) silence();
  } else if (cin >= 0x4 && cin <= 0x7) {
    // SysEx: 4 starts or continues (3 bytes), 5/6/7 end it with 1/2/3 bytes.
    int n = cin == 0x4 ? 3 : cin - 0x4;
    for (int i = 0; i < n && sysexLength < (int)sizeof(sysex); i++) sysex[sysexLength++] = m[i];
    if (cin != 0x4) {
      Serial.print("sysex");
      for (int i = 0; i < sysexLength; i++) Serial.printf(" %02X", sysex[i]);
      Serial.println();
      sysexLength = 0;
    }
  } else {
    int n = (cin == 0xc || cin == 0xd || cin == 0x2) ? 2 : (cin == 0xf || cin == 0x5) ? 1 : 3;
    Serial.print("midi");
    for (int i = 0; i < n; i++) Serial.printf(" %02X", m[i]);
    Serial.println();
  }
  (void)status;
}

void setup() {
  ledcSetup(CHANNEL, 1000, 10);
  ledcAttachPin(SPEAKER_PIN, CHANNEL);
  ledcWriteTone(CHANNEL, 0);
  USB.begin();
  Serial.begin(115200);
  while (!Serial) delay(10);
  Serial.println("usb synth ready");
}

void loop() {
  uint8_t packet[4];
  while (tud_midi_available() && tud_midi_packet_read(packet)) message(packet[0] & 0x0f, packet + 1);
  delay(1);
}
