// wifi-ping — tests assert (BT98): joins "benchtop" (the bench's wifi-ap), prints "connected <ip>
// gateway <ip>", pings the gateway four times, 200 ms apart, with lwIP's ping (esp_ping: ICMP
// echo from the firmware's own stack) and prints each reply, then "ping done <replies>/4".
#include <WiFi.h>
#include "ping/ping_sock.h"

static volatile uint32_t replies = 0;
static volatile bool finished = false;

static void onSuccess(esp_ping_handle_t hdl, void *) {
  uint16_t seq;
  uint32_t elapsed;
  esp_ping_get_profile(hdl, ESP_PING_PROF_SEQNO, &seq, sizeof(seq));
  esp_ping_get_profile(hdl, ESP_PING_PROF_TIMEGAP, &elapsed, sizeof(elapsed));
  replies++;
  Serial.printf("reply seq=%u time=%lu ms\n", seq, (unsigned long)elapsed);
}

static void onTimeout(esp_ping_handle_t, void *) {
  Serial.println("timeout");
}

static void onEnd(esp_ping_handle_t, void *) {
  finished = true;
}

void setup() {
  Serial.begin(115200);
  WiFi.begin("benchtop", "simulated");
  while (WiFi.status() != WL_CONNECTED) delay(50);
  Serial.printf("connected %s gateway %s\n", WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str());
  esp_ping_config_t config = ESP_PING_DEFAULT_CONFIG();
  config.target_addr.type = IPADDR_TYPE_V4;
  config.target_addr.u_addr.ip4.addr = (uint32_t)WiFi.gatewayIP();
  config.count = 4;
  config.interval_ms = 200;
  esp_ping_callbacks_t callbacks = {};
  callbacks.on_ping_success = onSuccess;
  callbacks.on_ping_timeout = onTimeout;
  callbacks.on_ping_end = onEnd;
  esp_ping_handle_t ping;
  esp_ping_new_session(&config, &callbacks, &ping);
  esp_ping_start(ping);
  while (!finished) delay(10);
  Serial.printf("ping done %lu/4\n", (unsigned long)replies);
  esp_ping_delete_session(ping);
}

void loop() {
  delay(1000);
}
