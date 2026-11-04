// prefs-types — tests assert (BT119): writes one Preferences value of each kind NVS stores, in
// namespace "types" — "u8" 200 (putUChar), "i8" -100 (putChar), "u16" 60000, "i16" -30000,
// "u32" 4000000000, "i32" -2000000000, "u64" 18000000000000000000, "i64" -9000000000000000000,
// "bool" true (a u8), "short" "hi", "long" a 100-character string (several entries), "float" 1.5
// (a 4-byte blob), "big" a 5000-byte blob (bytes i & 0xFF: chunks over two pages) — and one in
// namespace "other": "n" 7. Then prints "written" at 115200 baud. A line "erase u32" on Serial
// removes that key and prints "removed".
#include <Preferences.h>

Preferences prefs;
uint8_t big[5000];

void setup() {
  Serial.begin(115200);
  prefs.begin("types", false);
  prefs.putUChar("u8", 200);
  prefs.putChar("i8", -100);
  prefs.putUShort("u16", 60000);
  prefs.putShort("i16", -30000);
  prefs.putUInt("u32", 4000000000UL);
  prefs.putInt("i32", -2000000000L);
  prefs.putULong64("u64", 18000000000000000000ULL);
  prefs.putLong64("i64", -9000000000000000000LL);
  prefs.putBool("bool", true);
  prefs.putString("short", "hi");
  String text;
  for (int i = 0; i < 100; i++) text += (char)('a' + i % 26);
  prefs.putString("long", text);
  prefs.putFloat("float", 1.5f);
  for (int i = 0; i < 5000; i++) big[i] = i & 0xff;
  prefs.putBytes("big", big, sizeof big);
  prefs.end();
  prefs.begin("other", false);
  prefs.putUInt("n", 7);
  prefs.end();
  Serial.println("written");
}

void loop() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line == "erase u32") {
      prefs.begin("types", false);
      prefs.remove("u32");
      prefs.end();
      Serial.println("removed");
    }
  }
  delay(10);
}
