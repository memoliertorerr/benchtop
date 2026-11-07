// wifi-rgb-server (ESP32-S3, BT129: the C3's sketch) — tests assert (BT108): the board joins
// "benchtop" as "s3-web" and serves on port 80 with Arduino's WebServer. "/" answers "hello from
// esp32-s3"; "/led?color=<c>" sets the DevKitC-1's RGB LED (a WS2812 on GPIO48, neopixelWrite) — red, green, blue, white, off, or
// rrggbb in hex — and answers "led <c>"; an unknown color is 400 "bad color", anything else 404
// "not here". Prints "server at <ip>" once listening and "led <c>" for each color it shows.
#include <WiFi.h>
#include <WebServer.h>

WebServer server(80);

static bool parseColor(const String &name, uint8_t &r, uint8_t &g, uint8_t &b) {
  if (name == "red") { r = 255; g = 0; b = 0; return true; }
  if (name == "green") { r = 0; g = 255; b = 0; return true; }
  if (name == "blue") { r = 0; g = 0; b = 255; return true; }
  if (name == "white") { r = 64; g = 64; b = 64; return true; }
  if (name == "off") { r = 0; g = 0; b = 0; return true; }
  if (name.length() != 6) return false;
  for (size_t i = 0; i < 6; i++) if (!isxdigit((unsigned char)name[i])) return false;
  unsigned long v = strtoul(name.c_str(), nullptr, 16);
  r = (v >> 16) & 0xff;
  g = (v >> 8) & 0xff;
  b = v & 0xff;
  return true;
}

void handleRoot() {
  server.send(200, "text/plain", "hello from esp32-s3");
}

void handleLed() {
  String color = server.arg("color");
  color.toLowerCase();
  uint8_t r, g, b;
  if (!parseColor(color, r, g, b)) {
    server.send(400, "text/plain", "bad color");
    return;
  }
  neopixelWrite(RGB_BUILTIN, r, g, b);
  Serial.printf("led %s\n", color.c_str());
  server.send(200, "text/plain", "led " + color);
}

void handleMissing() {
  server.send(404, "text/plain", "not here");
}

void setup() {
  Serial.begin(115200);
  neopixelWrite(RGB_BUILTIN, 0, 0, 0);
  WiFi.setHostname("s3-web");
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
