// speaker-melody — tests assert (BT41): "melody" on Serial (115200), then tone() on D8 at 440,
// 523 and 659 Hz for 250 ms each, back to back, then silence; a speaker on D8 plays the three
// notes in tune.
void setup() {
  Serial.begin(115200);
  Serial.println("melody");
  const unsigned int notes[] = {440, 523, 659};
  for (unsigned int note : notes) {
    tone(8, note);
    delay(250);
  }
  noTone(8);
}

void loop() {
}
