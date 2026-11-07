// pot-led — tests assert (BT126): a potentiometer's wiper on GPIO1 (ADC1 channel 0, 11 dB, 12 bits)
// sets the brightness of an LED on GPIO2 (LEDC channel 0, 5 kHz, 10 bits — the S3's LEDC runs from
// the 80 MHz APB clock); every 100 ms it prints "pot=<0–4095> duty=<0–1023>".
const int POT = 1;
const int LED = 2;

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  ledcSetup(0, 5000, 10);
  ledcAttachPin(LED, 0);
}

void loop() {
  int pot = analogRead(POT);
  int duty = pot >> 2;
  ledcWrite(0, duty);
  Serial.printf("pot=%d duty=%d\n", pot, duty);
  delay(100);
}
