// wifi-webserver — tests assert (BT100): joins "benchtop" as "esp32-web" and serves on port 80
// with Arduino's WebServer: "/" → "hello from esp32", "/led?state=on|off" switches the LED on
// GPIO2 and answers "led on" / "led off", anything else 404 "not here". Prints "server at <ip>"
// once listening and "<method> <uri>" for each request it handles.
#include <WiFi.h>
#include <WebServer.h>

const int LED = 2;
WebServer server(80);

void handleRoot() {
  Serial.println("GET /");
  server.send(200, "text/plain", "hello from esp32");
}

void handleLed() {
  bool on = server.arg("state") == "on";
  digitalWrite(LED, on ? HIGH : LOW);
  Serial.printf("GET /led %s\n", on ? "on" : "off");
  server.send(200, "text/plain", on ? "led on" : "led off");
}

void handleMissing() {
  Serial.printf("missing %s\n", server.uri().c_str());
  server.send(404, "text/plain", "not here");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
  WiFi.setHostname("esp32-web");
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
