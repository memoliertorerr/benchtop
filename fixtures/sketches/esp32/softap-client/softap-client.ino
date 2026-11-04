// softap-client — tests assert (BT116): joins "benchtop-ap" — another board's soft AP, no
// access-point part — as "esp32-client" and prints "connected <ip> gateway <gateway>", then GETs
// http://192.168.4.1/ with HTTPClient three times, a second apart, printing "GET <code> <body>"
// each time, then leaves with WiFi.disconnect() and prints "left".
#include <WiFi.h>
#include <HTTPClient.h>

void setup() {
  Serial.begin(115200);
  WiFi.setHostname("esp32-client");
  WiFi.begin("benchtop-ap", "simulated1");
  while (WiFi.status() != WL_CONNECTED) delay(50);
  Serial.printf("connected %s gateway %s\n", WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str());
  for (int i = 0; i < 3; i++) {
    HTTPClient http;
    http.begin("http://192.168.4.1/");
    int code = http.GET();
    Serial.printf("GET %d %s\n", code, code > 0 ? http.getString().c_str() : http.errorToString(code).c_str());
    http.end();
    delay(1000);
  }
  WiFi.disconnect();
  Serial.println("left");
}

void loop() {
  delay(1000);
}
