// https-get — tests assert (BT104): HTTPS from the ESP32 — mbedTLS on the SHA, AES and RSA
// accelerators. Joins "benchtop", prints "ready", then reads a CA certificate from serial (PEM,
// through its END line) or the word INSECURE, and GETs https://secure.bench/hello with HTTPClient
// over WiFiClientSecure (setCACert, or setInsecure), printing "GET <code> <body or error>" and
// "took <ms> ms". Each further line on serial repeats the request ("again").
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

static String ca;
static bool insecure = false;

static void request() {
  WiFiClientSecure client;
  if (insecure) client.setInsecure();
  else client.setCACert(ca.c_str());
  HTTPClient https;
  unsigned long start = millis();
  if (!https.begin(client, "https://secure.bench/hello")) {
    Serial.println("GET -1 begin failed");
    return;
  }
  int code = https.GET();
  if (code > 0) Serial.printf("GET %d %s\n", code, https.getString().c_str());
  else Serial.printf("GET %d %s\n", code, https.errorToString(code).c_str());
  https.end();
  Serial.printf("took %lu ms\n", millis() - start);
}

void setup() {
  Serial.setRxBufferSize(4096);
  Serial.begin(115200);
  WiFi.begin("benchtop", "simulated");
  while (WiFi.status() != WL_CONNECTED) delay(50);
  Serial.println("ready");
  for (;;) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;
    if (line == "INSECURE") {
      insecure = true;
      break;
    }
    ca += line;
    ca += "\n";
    if (line.startsWith("-----END CERTIFICATE-----")) break;
  }
  request();
}

void loop() {
  if (Serial.available()) {
    Serial.readStringUntil('\n');
    request();
  }
  delay(10);
}
