// adc-read — tests assert (BT35): every 20 ms a line
// "a=<GPIO34, 11 dB, 12 bits> z=<GPIO34, 0 dB> r=<GPIO34, 11 dB, analogReadResolution(10)>
//  c=<GPIO36>,<GPIO39>,<GPIO32>,<GPIO33>,<GPIO35>" (one line, ADC1 channels 0, 3, 4, 5, 7).
// With the idealized linear model: 0 / 0.825 / 1.65 / 2.475 / 3.3 V at 11 dB read
// 0 / 1024 / 2048 / 3071 / 4095 (±3), 0.55 V at 0 dB reads 2048 (±3).
void setup() {
  Serial.begin(115200);
}

void loop() {
  analogReadResolution(12);
  analogSetPinAttenuation(34, ADC_11db);
  int a = analogRead(34);
  analogSetPinAttenuation(34, ADC_0db);
  int z = analogRead(34);
  analogSetPinAttenuation(34, ADC_11db);
  analogReadResolution(10);
  int r = analogRead(34);
  analogReadResolution(12);
  int c36 = analogRead(36);
  int c39 = analogRead(39);
  int c32 = analogRead(32);
  int c33 = analogRead(33);
  int c35 = analogRead(35);
  Serial.printf("a=%d z=%d r=%d c=%d,%d,%d,%d,%d\n", a, z, r, c36, c39, c32, c33, c35);
  delay(20);
}
