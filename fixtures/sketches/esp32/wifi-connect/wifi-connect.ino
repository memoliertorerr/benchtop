// wifi-connect — tests drive it over serial (BT98): "join <ssid> <password>" calls
// WiFi.begin(ssid, password), "leave" calls WiFi.disconnect(). Prints "ready" after
// WiFi.mode(WIFI_STA), then every change of WiFi.status() as "status <n> at <ms>" (and the
// address when connected: "ip <a.b.c.d>").
#include <WiFi.h>

static wl_status_t last = (wl_status_t)255;
static String line;

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  Serial.println("ready");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      if (line.startsWith("join ")) {
        int space = line.indexOf(' ', 5);
        String ssid = space < 0 ? line.substring(5) : line.substring(5, space);
        String password = space < 0 ? String("") : line.substring(space + 1);
        WiFi.begin(ssid.c_str(), password.c_str());
        Serial.printf("joining %s\n", ssid.c_str());
      } else if (line == "leave") {
        WiFi.disconnect();
        Serial.println("leaving");
      }
      line = "";
    } else if (c != '\r') {
      line += c;
    }
  }
  wl_status_t now = WiFi.status();
  if (now != last) {
    last = now;
    Serial.printf("status %d at %lu\n", (int)now, (unsigned long)millis());
    if (now == WL_CONNECTED) Serial.printf("ip %s\n", WiFi.localIP().toString().c_str());
  }
  delay(10);
}
