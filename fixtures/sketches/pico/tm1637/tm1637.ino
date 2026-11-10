// tm1637 — tests assert: a clock on a TM1637 4-digit module from a Pico (CLK GP2, DIO GP3, the
// module on 3V3), the bus driven as TM1637Display does (open drain, 50 µs a bit, LSB first).
// It shows minutes and seconds since start as "MM:SS" (the colon lit for the first half of each
// second) at brightness 2 (4/16), and prints "time MM:SS" at 115200 baud once a second.

const int CLK = 2;
const int DIO = 3;
const uint8_t DIGITS[] = {0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f};

void bitDelay() { delayMicroseconds(50); }

void start() {
  pinMode(DIO, OUTPUT);
  bitDelay();
}

void stop() {
  pinMode(DIO, OUTPUT);
  bitDelay();
  pinMode(CLK, INPUT);
  bitDelay();
  pinMode(DIO, INPUT);
  bitDelay();
}

void writeByte(uint8_t b) {
  for (uint8_t i = 0; i < 8; i++) {
    pinMode(CLK, OUTPUT);
    bitDelay();
    pinMode(DIO, (b & 0x01) ? INPUT : OUTPUT);
    bitDelay();
    pinMode(CLK, INPUT);
    bitDelay();
    b >>= 1;
  }
  pinMode(CLK, OUTPUT);
  pinMode(DIO, INPUT);
  bitDelay();
  pinMode(CLK, INPUT);
  bitDelay();
  if (digitalRead(DIO) == 0) pinMode(DIO, OUTPUT);
  bitDelay();
  pinMode(CLK, OUTPUT);
  bitDelay();
}

void show(const uint8_t segments[4], uint8_t brightness) {
  start();
  writeByte(0x40);
  stop();
  start();
  writeByte(0xc0);
  for (int k = 0; k < 4; k++) writeByte(segments[k]);
  stop();
  start();
  writeByte(0x88 | brightness);
  stop();
}

void setup() {
  Serial.begin(115200);
  pinMode(CLK, INPUT);
  pinMode(DIO, INPUT);
  digitalWrite(CLK, LOW);
  digitalWrite(DIO, LOW);
}

unsigned long lastSecond = 0xFFFFFFFF;
bool lastColon = false;

void loop() {
  unsigned long ms = millis();
  unsigned long seconds = ms / 1000;
  bool colon = (ms % 1000) < 500;
  if (seconds == lastSecond && colon == lastColon) return;
  unsigned int mm = (seconds / 60) % 100;
  unsigned int ss = seconds % 60;
  uint8_t segments[4] = {DIGITS[mm / 10], DIGITS[mm % 10], DIGITS[ss / 10], DIGITS[ss % 10]};
  if (colon) segments[1] |= 0x80;
  show(segments, 2);
  if (seconds != lastSecond) {
    char line[16];
    snprintf(line, sizeof line, "time %02u:%02u", mm, ss);
    Serial.println(line);
  }
  lastSecond = seconds;
  lastColon = colon;
}
