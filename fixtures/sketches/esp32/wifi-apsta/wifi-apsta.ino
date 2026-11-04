// wifi-apsta — tests assert (BT116): AP and station at once (WIFI_AP_STA). Hosts the open access
// point "bridge-ap" at 192.168.5.1 (WiFi.softAPConfig: another subnet than its station's) and joins
// the bench's "benchtop" as "esp32-bridge". Serves "/" → "sta <its station address>" on port 80
// (both interfaces). Prints "ap at <ip>" once hosting and "sta <ip>" once joined.
#include <WiFi.h>
#include <WebServer.h>

WebServer server(80);

void handleRoot() {
  Serial.println("GET /");
  server.send(200, "text/plain", "sta " + WiFi.localIP().toString());
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAPConfig(IPAddress(192, 168, 5, 1), IPAddress(192, 168, 5, 1), IPAddress(255, 255, 255, 0));
  WiFi.softAP("bridge-ap");
  Serial.printf("ap at %s\n", WiFi.softAPIP().toString().c_str());
  WiFi.setHostname("esp32-bridge");
  WiFi.begin("benchtop", "simulated");
  while (WiFi.status() != WL_CONNECTED) delay(50);
  server.on("/", handleRoot);
  server.begin();
  Serial.printf("sta %s\n", WiFi.localIP().toString().c_str());
}

void loop() {
  server.handleClient();
  delay(2);
}
