// adc-read — tests assert (BT125): every 20 ms a line "a=<GPIO1, 11 dB> z=<GPIO1, 0 dB>
// r=<GPIO1, 11 dB, analogReadResolution(10)> c=<GPIO2>,<GPIO3>,<GPIO4>,<GPIO11>" — ADC1 channels
// 0–3 and ADC2 channel 0, 11 dB, 12 bits — read through the idealized linear model at the S3's
// attenuation ranges.
void setup() {
  Serial.begin(115200);
}

void loop() {
  analogReadResolution(12);
  analogSetPinAttenuation(1, ADC_11db);
  int a = analogRead(1);
  analogSetPinAttenuation(1, ADC_0db);
  int z = analogRead(1);
  analogSetPinAttenuation(1, ADC_11db);
  analogReadResolution(10);
  int r = analogRead(1);
  analogReadResolution(12);
  int c2 = analogRead(2);
  int c3 = analogRead(3);
  int c4 = analogRead(4);
  int c11 = analogRead(11);
  Serial.printf("a=%d z=%d r=%d c=%d,%d,%d,%d\n", a, z, r, c2, c3, c4, c11);
  delay(20);
}
