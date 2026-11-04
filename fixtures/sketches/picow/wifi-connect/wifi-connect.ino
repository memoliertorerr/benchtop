// wifi-connect (Pico W) — tests drive it over serial (BT111): "join <ssid> [<password>]" calls
// WiFi.begin (which returns at once here: after WiFi.mode(), arduino-pico's begin doesn't wait —
// its ESP8266 compatibility), "leave" calls WiFi.disconnect(). Prints "ready" once USB serial is
// open, then "begin <status> at <ms>" when WiFi.begin returns,
// and every change of WiFi.status() or of the driver's link status
// (cyw43_wifi_link_status: 1 join, 0 down, -1 fail, -2 no network, -3 bad auth) as
// "status <s> link <l> at <ms>", with "ip <a.b.c.d>" when connected.
#include <WiFi.h>
#include <pico/cyw43_arch.h>

static int lastStatus = -100, lastLink = -100;
static String line;

static void report() {
  int s = WiFi.status();
  int l = cyw43_wifi_link_status(&cyw43_state, CYW43_ITF_STA);
  if (s == lastStatus && l == lastLink) return;
  lastStatus = s;
  lastLink = l;
  Serial.printf("status %d link %d at %lu\n", s, l, (unsigned long)millis());
  if (s == WL_CONNECTED) Serial.printf("ip %s\n", WiFi.localIP().toString().c_str());
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.setTimeout(3000);
  while (!Serial) delay(10);
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
        Serial.printf("joining %s\n", ssid.c_str());
        int s = password.length() > 0 ? WiFi.begin(ssid.c_str(), password.c_str()) : WiFi.begin(ssid.c_str());
        Serial.printf("begin %d at %lu\n", s, (unsigned long)millis());
      } else if (line == "leave") {
        WiFi.disconnect();
        Serial.println("leaving");
      }
      line = "";
    } else if (c != '\r') {
      line += c;
    }
  }
  report();
  delay(10);
}
