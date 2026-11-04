// wifi-tcp-client — tests assert (BT100, with wifi-tcp-server on a second board): joins
// "benchtop", finds "echo-server" through the gateway's DNS (the other board's DHCP hostname),
// connects to its TCP port 7000, sends "hello bench" and prints "reply HELLO BENCH"; it retries the
// connection every 200 ms while the server isn't up yet.
#include <WiFi.h>

void setup() {
  Serial.begin(115200);
  WiFi.begin("benchtop", "simulated");
  while (WiFi.status() != WL_CONNECTED) delay(50);
  Serial.printf("client at %s\n", WiFi.localIP().toString().c_str());
  WiFiClient client;
  for (int tries = 0; tries < 50 && !client.connect("echo-server", 7000); tries++) delay(200);
  if (!client.connected()) {
    Serial.println("no server");
    return;
  }
  client.print("hello bench\n");
  String reply = client.readStringUntil('\n');
  Serial.printf("reply %s\n", reply.c_str());
  client.stop();
}

void loop() {
  delay(1000);
}
