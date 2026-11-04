// wifi-webserver (Pico 2 W) — tests assert (BT114): joins "benchtop" as "pico2w-web" and serves on
// port 80 with arduino-pico's WebServer: "/" → "hello from pico 2 w", "/led?state=on|off" switches
// the board's LED (on the CYW43439's WL_GPIO0) and answers "led on" / "led off", anything else
// 404 "not here". Prints "server at <ip>" once listening and "GET /led on|off" for each switch.
#include <WiFi.h>
#include <WebServer.h>

WebServer server(80);

void handleRoot() {
  server.send(200, "text/plain", "hello from pico 2 w");
}

void handleLed() {
  bool on = server.arg("state") == "on";
  digitalWrite(LED_BUILTIN, on ? HIGH : LOW);
  Serial.printf("GET /led %s\n", on ? "on" : "off");
  server.send(200, "text/plain", on ? "led on" : "led off");
}

void handleMissing() {
  server.send(404, "text/plain", "not here");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  WiFi.setHostname("pico2w-web");
  WiFi.begin("benchtop", "simulated");
  while (WiFi.status() != WL_CONNECTED) delay(50);
  server.on("/", handleRoot);
  server.on("/led", handleLed);
  server.onNotFound(handleMissing);
  server.begin();
  Serial.printf("server at %s\n", WiFi.localIP().toString().c_str());
}

void loop() {
  server.handleClient();
  delay(2);
}
