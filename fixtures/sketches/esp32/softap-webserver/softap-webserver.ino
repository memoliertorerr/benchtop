// softap-webserver — tests assert (BT117): the gallery's access-point web server. Hosts its own
// network "esp32-ap" (WPA2, "simulated1") with WiFi.softAP — no router needed — and serves at
// 192.168.4.1 with Arduino's WebServer: "/" → "hello from the esp32 ap", "/led?state=on|off"
// switches the LED on GPIO2 and answers "led on" / "led off". Prints "ap esp32-ap at 192.168.4.1"
// once listening, "joined <mac>" for each station that joins, "GET /led on|off" for each switch.
#include <WiFi.h>
#include <WebServer.h>

const int LED = 2;
WebServer server(80);

void onJoined(arduino_event_id_t event, arduino_event_info_t info) {
  const uint8_t *m = info.wifi_ap_staconnected.mac;
  Serial.printf("joined %02x:%02x:%02x:%02x:%02x:%02x\n", m[0], m[1], m[2], m[3], m[4], m[5]);
}

void handleRoot() {
  server.send(200, "text/plain", "hello from the esp32 ap");
}

void handleLed() {
  bool on = server.arg("state") == "on";
  digitalWrite(LED, on ? HIGH : LOW);
  Serial.printf("GET /led %s\n", on ? "on" : "off");
  server.send(200, "text/plain", on ? "led on" : "led off");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
  WiFi.onEvent(onJoined, ARDUINO_EVENT_WIFI_AP_STACONNECTED);
  WiFi.softAP("esp32-ap", "simulated1");
  server.on("/", handleRoot);
  server.on("/led", handleLed);
  server.begin();
  Serial.printf("ap esp32-ap at %s\n", WiFi.softAPIP().toString().c_str());
}

void loop() {
  server.handleClient();
  delay(2);
}
