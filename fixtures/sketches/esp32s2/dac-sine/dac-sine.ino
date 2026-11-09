// dac-sine — tests assert (BT164): "dac" on Serial (115200), then dacWrite(17, …) steps through a
// 32-entry sine table (codes 0–255) at 16 kHz, paced by micros(): a 500 Hz sine on GPIO17 (the
// S2's DAC channel 1, code / 255 · 3.3 V), forever. The ESP32's dac-sine on the S2's DAC pin; the
// CPU runs at 80 MHz, as there.
uint8_t table[32];

void setup() {
  setCpuFrequencyMhz(80);
  Serial.begin(115200);
  for (int i = 0; i < 32; i++) table[i] = (uint8_t)lround(127.5 + 127.5 * sin(2 * PI * i / 32));
  Serial.println("dac");
}

void loop() {
  static uint32_t start = micros();
  static uint32_t n = 0;
  while ((uint32_t)(micros() - start) < (n * 125) / 2) {
  }
  dacWrite(17, table[n & 31]);
  n++;
}
