// wifi-softap — tests assert (BT116): hosts the access point "benchtop-ap" (WPA2, "simulated1",
// channel 6) with WiFi.softAP and serves on port 80 at 192.168.4.1 with Arduino's WebServer:
// "/" → "hello from the ap", "/stations" → the station count. Prints, in order:
//   "layout <sizeof wifi_event_ap_staconnected_t> <offsetof aid> <sizeof
//   wifi_event_ap_stadisconnected_t> <sizeof wifi_sta_info_t> <offsetof rssi> <sizeof
//   wifi_sta_list_t> <offsetof num>" — the event and list layouts as this toolchain builds them;
//   "ap at <ip> <AP MAC>" once listening;
//   "joined <mac> aid <n>" and "left <mac> aid <n>" for each AP_STACONNECTED / AP_STADISCONNECTED;
//   "assigned <ip>" for each address its DHCP server hands out (IP_EVENT_AP_STAIPASSIGNED);
//   "stations <n>: <mac> <rssi> …" from esp_wifi_ap_get_sta_list after each change;
//   "GET <uri>" for each request it serves.
#include <WiFi.h>
#include <WebServer.h>
#include <esp_wifi.h>
#include <stddef.h>

WebServer server(80);
volatile bool changed = false;

static void macText(char *out, const uint8_t *mac) {
  sprintf(out, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

void onEvent(arduino_event_id_t event, arduino_event_info_t info) {
  char mac[18];
  switch (event) {
    case ARDUINO_EVENT_WIFI_AP_STACONNECTED:
      macText(mac, info.wifi_ap_staconnected.mac);
      Serial.printf("joined %s aid %d\n", mac, info.wifi_ap_staconnected.aid);
      changed = true;
      break;
    case ARDUINO_EVENT_WIFI_AP_STADISCONNECTED:
      macText(mac, info.wifi_ap_stadisconnected.mac);
      Serial.printf("left %s aid %d\n", mac, info.wifi_ap_stadisconnected.aid);
      changed = true;
      break;
    case ARDUINO_EVENT_WIFI_AP_STAIPASSIGNED:
      Serial.printf("assigned %s\n", IPAddress(info.wifi_ap_staipassigned.ip.addr).toString().c_str());
      break;
    default:
      break;
  }
}

void handleRoot() {
  Serial.println("GET /");
  server.send(200, "text/plain", "hello from the ap");
}

void handleStations() {
  Serial.println("GET /stations");
  server.send(200, "text/plain", String(WiFi.softAPgetStationNum()));
}

void setup() {
  Serial.begin(115200);
  Serial.printf("layout %u %u %u %u %u %u %u\n", (unsigned)sizeof(wifi_event_ap_staconnected_t), (unsigned)offsetof(wifi_event_ap_staconnected_t, aid),
                (unsigned)sizeof(wifi_event_ap_stadisconnected_t), (unsigned)sizeof(wifi_sta_info_t), (unsigned)offsetof(wifi_sta_info_t, rssi),
                (unsigned)sizeof(wifi_sta_list_t), (unsigned)offsetof(wifi_sta_list_t, num));
  WiFi.onEvent(onEvent);
  WiFi.softAP("benchtop-ap", "simulated1", 6);
  server.on("/", handleRoot);
  server.on("/stations", handleStations);
  server.begin();
  Serial.printf("ap at %s %s\n", WiFi.softAPIP().toString().c_str(), WiFi.softAPmacAddress().c_str());
}

void loop() {
  if (changed) {
    changed = false;
    wifi_sta_list_t list;
    if (esp_wifi_ap_get_sta_list(&list) == ESP_OK) {
      // One print for the line: the event task's lines can't land inside it.
      String line = "stations " + String(list.num) + ":";
      for (int i = 0; i < list.num; i++) {
        char entry[32];
        char mac[18];
        macText(mac, list.sta[i].mac);
        sprintf(entry, " %s %d", mac, list.sta[i].rssi);
        line += entry;
      }
      Serial.println(line);
    }
  }
  server.handleClient();
  delay(2);
}
