// usb-drive (ESP32-S3) — tests assert (BT141), and the gallery's USB drive (BT142): built with the
// USB Mode "USB-OTG (TinyUSB)" and USB CDC On Boot (the `benchtop: usb-otg` line below), the S3's
// own USB is one device with a CDC-ACM port (`Serial`) and a USB flash drive (Arduino's USBMSC):
// a 64 KB RAM disk the sketch lays out itself as FAT12 — 512-byte sectors, one per cluster; sector
// 0 the boot sector, 1 the FAT, 2 the root directory (16 entries), clusters 2… from sector 3 —
// holding README.TXT and COUNT.TXT ("count=<n>").
//   A button to GND on IO4 (INPUT_PULLUP) adds one to the count and rewrites COUNT.TXT; the sketch
//   then takes the medium away for 1.5 s (mediaPresent), so the computer reads the drive again.
//   Every 200 ms it looks in the root directory for CONFIG.TXT, a file the computer may write:
//   "led=red|green|blue|white|off" sets the board's RGB LED (a WS2812 on GPIO48).
// Serial prints "usb drive ready" once the computer opens the port, then "count <n>",
// "config <text>" and "led <color>".
// benchtop: usb-otg

#include "USB.h"
#include "USBMSC.h"

USBMSC msc;

const uint32_t SECTORS = 128;
const uint16_t SECTOR = 512;
static uint8_t disk[SECTORS * SECTOR];
const uint32_t FAT_SECTOR = 1, ROOT_SECTOR = 2, DATA_SECTOR = 3;
const char README[] = "This drive is an ESP32-S3's RAM, served over USB by the sketch.\r\n"
                      "Write a CONFIG.TXT holding led=red, green, blue, white or off.\r\n";

int count = 0;
bool released = true;
uint32_t lastConfig = 0;
String lastText;

static void put16(uint8_t *p, uint16_t v) {
  p[0] = v & 0xff;
  p[1] = v >> 8;
}
static void put32(uint8_t *p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = (v >> (8 * i)) & 0xff;
}
static uint16_t get16(const uint8_t *p) {
  return p[0] | (p[1] << 8);
}
static uint32_t get32(const uint8_t *p) {
  return get16(p) | ((uint32_t)get16(p + 2) << 16);
}

// A root directory entry: an 8.3 name ("README  TXT"), attributes, first cluster, size.
static void entry(int index, const char *name83, uint8_t attr, uint16_t cluster, uint32_t size) {
  uint8_t *e = disk + ROOT_SECTOR * SECTOR + index * 32;
  memset(e, 0, 32);
  memcpy(e, name83, 11);
  e[11] = attr;
  put16(e + 24, (46 << 9) | (1 << 5) | 1);  // 2026-01-01
  put16(e + 26, cluster);
  put32(e + 28, size);
}

static void writeCount() {
  char text[32];
  int n = snprintf(text, sizeof text, "count=%d\r\n", count);
  uint8_t *data = disk + (DATA_SECTOR + 1) * SECTOR;  // cluster 3
  memset(data, 0, SECTOR);
  memcpy(data, text, n);
  entry(2, "COUNT   TXT", 0x20, 3, n);
}

static void format() {
  memset(disk, 0, sizeof disk);
  uint8_t *b = disk;
  b[0] = 0xeb;
  b[1] = 0x3c;
  b[2] = 0x90;
  memcpy(b + 3, "BENCHTOP", 8);
  put16(b + 11, SECTOR);  // bytes per sector
  b[13] = 1;              // sectors per cluster
  put16(b + 14, 1);       // reserved sectors: the boot sector
  b[16] = 1;              // FATs
  put16(b + 17, 16);      // root entries
  put16(b + 19, SECTORS);
  b[21] = 0xf8;      // media
  put16(b + 22, 1);  // sectors per FAT
  put16(b + 24, 1);  // sectors per track
  put16(b + 26, 1);  // heads
  b[36] = 0x80;      // drive number
  b[38] = 0x29;      // extended boot signature
  put32(b + 39, 0x20261108);
  memcpy(b + 43, "S3 DRIVE   ", 11);
  memcpy(b + 54, "FAT12   ", 8);
  b[510] = 0x55;
  b[511] = 0xaa;
  // The FAT: entries 0 and 1 (media), clusters 2 and 3 each a whole file (end of chain 0xFFF).
  uint8_t *fat = disk + FAT_SECTOR * SECTOR;
  fat[0] = 0xf8;
  fat[1] = 0xff;
  fat[2] = 0xff;
  fat[3] = 0xff;
  fat[4] = 0xff;
  fat[5] = 0xff;
  entry(0, "S3 DRIVE   ", 0x08, 0, 0);  // the volume label
  entry(1, "README  TXT", 0x20, 2, sizeof README - 1);
  memcpy(disk + DATA_SECTOR * SECTOR, README, sizeof README - 1);
  writeCount();
}

static int32_t onRead(uint32_t lba, uint32_t offset, void *buffer, uint32_t size) {
  if (lba >= SECTORS) return -1;
  memcpy(buffer, disk + lba * SECTOR + offset, size);
  return size;
}

static int32_t onWrite(uint32_t lba, uint32_t offset, uint8_t *buffer, uint32_t size) {
  if (lba >= SECTORS) return -1;
  memcpy(disk + lba * SECTOR + offset, buffer, size);
  return size;
}

static bool onStartStop(uint8_t power, bool start, bool eject) {
  return true;
}

// CONFIG.TXT in the root directory: its first cluster's text (up to one sector), or "".
static String readConfig() {
  const uint8_t *root = disk + ROOT_SECTOR * SECTOR;
  for (int i = 0; i < 16; i++) {
    const uint8_t *e = root + i * 32;
    if (e[0] == 0) break;
    if (e[0] == 0xe5 || e[11] == 0x0f || (e[11] & 0x18) != 0) continue;
    if (memcmp(e, "CONFIG  TXT", 11) != 0) continue;
    uint16_t cluster = get16(e + 26);
    uint32_t size = get32(e + 28);
    if (cluster < 2 || DATA_SECTOR + cluster - 2 >= SECTORS) return "";
    if (size > SECTOR) size = SECTOR;
    String text;
    const uint8_t *data = disk + (DATA_SECTOR + cluster - 2) * SECTOR;
    for (uint32_t k = 0; k < size; k++) text += (char)data[k];
    text.trim();
    return text;
  }
  return "";
}

static void apply(const String &text) {
  Serial.printf("config %s\n", text.c_str());
  int at = text.indexOf("led=");
  if (at < 0) return;
  String color = text.substring(at + 4);
  color.trim();
  if (color == "red") neopixelWrite(RGB_BUILTIN, 255, 0, 0);
  else if (color == "green") neopixelWrite(RGB_BUILTIN, 0, 255, 0);
  else if (color == "blue") neopixelWrite(RGB_BUILTIN, 0, 0, 255);
  else if (color == "white") neopixelWrite(RGB_BUILTIN, 64, 64, 64);
  else if (color == "off") neopixelWrite(RGB_BUILTIN, 0, 0, 0);
  else return;
  Serial.printf("led %s\n", color.c_str());
}

void setup() {
  pinMode(4, INPUT_PULLUP);
  neopixelWrite(RGB_BUILTIN, 0, 0, 0);
  format();
  msc.vendorID("Benchtop");
  msc.productID("S3 RAM Drive");
  msc.productRevision("1.0");
  msc.onRead(onRead);
  msc.onWrite(onWrite);
  msc.onStartStop(onStartStop);
  msc.mediaPresent(true);
  msc.begin(SECTORS, SECTOR);
  USB.begin();
  Serial.begin(115200);
  while (!Serial) delay(10);
  Serial.println("usb drive ready");
}

void loop() {
  bool up = digitalRead(4) == HIGH;
  if (released && !up) {
    count++;
    writeCount();
    Serial.printf("count %d\n", count);
    msc.mediaPresent(false);  // the computer drops what it read …
    delay(1500);
    msc.mediaPresent(true);  // … and reads the drive again
  }
  released = up;
  if (millis() - lastConfig >= 200) {
    lastConfig = millis();
    String text = readConfig();
    if (text.length() > 0 && text != lastText) apply(text);
    lastText = text;
  }
  delay(10);
}
