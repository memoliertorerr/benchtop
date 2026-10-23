// adc-read — tests assert (BT93): every 20 ms a line "a=<GPIO0, 11 dB> z=<GPIO0, 0 dB>
// r=<GPIO0, 11 dB, analogReadResolution(10)> c=<GPIO1>,<GPIO2>,<GPIO3>,<GPIO4>" (ADC1 channels
// 0–4, 11 dB, 12 bits). With the idealized linear model (full scale 2.5 V at 11 dB, 0.75 V at
// 0 dB — the C3 datasheet's ranges): 0 / 0.625 / 1.25 / 1.875 / 2.5 V at 11 dB read
// 0 / 1024 / 2048 / 3071 / 4095 (±3), 0.375 V at 0 dB reads 2048 (±3).
void setup() {
  Serial.begin(115200);
}

void loop() {
  analogReadResolution(12);
  analogSetPinAttenuation(0, ADC_11db);
  int a = analogRead(0);
  analogSetPinAttenuation(0, ADC_0db);
  int z = analogRead(0);
  analogSetPinAttenuation(0, ADC_11db);
  analogReadResolution(10);
  int r = analogRead(0);
  analogReadResolution(12);
  int c1 = analogRead(1);
  int c2 = analogRead(2);
  int c3 = analogRead(3);
  int c4 = analogRead(4);
  Serial.printf("a=%d z=%d r=%d c=%d,%d,%d,%d\n", a, z, r, c1, c2, c3, c4);
  delay(20);
}
