// wifi-http-get — tests assert (BT99): joins "benchtop", GETs http://api.bench/api/hello with
// HTTPClient (the name from the gateway's DNS, TCP to the bench's http-server part) and prints
// "GET <code> <body>", then POSTs "ping" to /api/echo and prints "POST <code> <body>".
#include <WiFi.h>
#include <HTTPClient.h>

void setup() {
  Serial.begin(115200);
  WiFi.begin("benchtop", "simulated");
  while (WiFi.status() != WL_CONNECTED) delay(50);
  Serial.printf("connected %s\n", WiFi.localIP().toString().c_str());
  HTTPClient http;
  http.begin("http://api.bench/api/hello");
  int code = http.GET();
  Serial.printf("GET %d %s\n", code, code > 0 ? http.getString().c_str() : http.errorToString(code).c_str());
  http.end();
  http.begin("http://api.bench/api/echo");
  http.addHeader("Content-Type", "text/plain");
  code = http.POST("ping");
  Serial.printf("POST %d %s\n", code, code > 0 ? http.getString().c_str() : http.errorToString(code).c_str());
  http.end();
}

void loop() {
  delay(1000);
}
