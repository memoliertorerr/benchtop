// wifi-tcp-server — tests assert (BT100, with wifi-tcp-client on a second board): joins "benchtop"
// as "echo-server", listens on TCP 7000 and answers every line a client sends with the line in
// capitals. Prints "echo server at <ip>", then "client <ip>" and "line <text>" as they come.
#include <WiFi.h>

WiFiServer server(7000);

void setup() {
  Serial.begin(115200);
  WiFi.setHostname("echo-server");
  WiFi.begin("benchtop", "simulated");
  while (WiFi.status() != WL_CONNECTED) delay(50);
  server.begin();
  Serial.printf("echo server at %s\n", WiFi.localIP().toString().c_str());
}

void loop() {
  WiFiClient client = server.available();
  if (!client) {
    delay(5);
    return;
  }
  Serial.printf("client %s\n", client.remoteIP().toString().c_str());
  while (client.connected()) {
    if (client.available()) {
      String line = client.readStringUntil('\n');
      Serial.printf("line %s\n", line.c_str());
      line.toUpperCase();
      client.print(line + "\n");
    } else {
      delay(2);
    }
  }
  client.stop();
}
