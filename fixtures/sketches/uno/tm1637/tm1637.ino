// tm1637 — tests assert: a TM1637 4-digit module driven as TM1637Display does (CLK on 2, DIO on 3,
// open drain — pinMode OUTPUT pulls a line low, INPUT lets the module's pull-up raise it — 100 µs
// a bit, LSB first, reading the ACK on the ninth clock). Setup: brightness 7 (14/16), "1234",
// then prints "acks <received>/<sent>" at 115200 baud. Every 200 ms from 500 ms it shows the
// count right-aligned without leading zeros, the colon on odd counts, printing "n=<count>".

const int CLK = 2;
const int DIO = 3;
const uint8_t DIGITS[] = {0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f};

int sent = 0;
int acked = 0;

void bitDelay() { delayMicroseconds(100); }

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
  uint8_t ack = digitalRead(DIO);
  if (ack == 0) pinMode(DIO, OUTPUT);
  bitDelay();
  pinMode(CLK, OUTPUT);
  bitDelay();
  sent++;
  if (ack == 0) acked++;
}

void setSegments(const uint8_t segments[4]) {
  start();
  writeByte(0x40);
  stop();
  start();
  writeByte(0xc0);
  for (int k = 0; k < 4; k++) writeByte(segments[k]);
  stop();
  start();
  writeByte(0x88 | 7);
  stop();
}

void setup() {
  Serial.begin(115200);
  pinMode(CLK, INPUT);
  pinMode(DIO, INPUT);
  digitalWrite(CLK, LOW);
  digitalWrite(DIO, LOW);
  const uint8_t hello[4] = {DIGITS[1], DIGITS[2], DIGITS[3], DIGITS[4]};
  setSegments(hello);
  Serial.print("acks ");
  Serial.print(acked);
  Serial.print('/');
  Serial.println(sent);
  delay(500);
}

uint16_t count = 0;

void loop() {
  uint8_t segments[4] = {0, 0, 0, 0};
  uint16_t v = count;
  for (int k = 3; k >= 0; k--) {
    if (k == 3 || v > 0) segments[k] = DIGITS[v % 10];
    v /= 10;
  }
  if (count & 1) segments[1] |= 0x80;
  setSegments(segments);
  Serial.print("n=");
  Serial.println(count);
  count++;
  delay(200);
}
