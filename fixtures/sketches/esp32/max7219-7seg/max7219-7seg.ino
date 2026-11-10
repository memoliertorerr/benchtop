// max7219-7seg — tests assert: a MAX7219 8-digit 7-segment module bit-banged as LedControl does
// (shiftOut MSB first, CS low around each 16-bit word) on DIN GPIO13, CLK GPIO14, CS GPIO27, the
// module powered from VIN's 5 V. Setup: display test off, scan limit 7, Code B on every digit,
// intensity 8, normal operation; shows "-HELP-01." (Code B 10, 12, 11, 13, 14, 10, 0 and 1 with
// its point, digit 7 the leftmost) and prints "help" at 115200 baud. From 500 ms it counts: every
// 100 ms the count right-aligned, blanks (Code B 15) before it, printing "n=<count>".

const int DIN = 13;
const int CLK = 14;
const int CS = 27;

void send(uint8_t reg, uint8_t data) {
  digitalWrite(CS, LOW);
  shiftOut(DIN, CLK, MSBFIRST, reg);
  shiftOut(DIN, CLK, MSBFIRST, data);
  digitalWrite(CS, HIGH);
}

void setup() {
  Serial.begin(115200);
  pinMode(DIN, OUTPUT);
  pinMode(CLK, OUTPUT);
  pinMode(CS, OUTPUT);
  digitalWrite(CS, HIGH);
  send(0x0F, 0);
  send(0x0B, 7);
  send(0x09, 0xFF);
  send(0x0A, 8);
  send(0x0C, 1);
  const uint8_t help[8] = {0x81, 0, 10, 14, 13, 11, 12, 10};  // digit 0 (rightmost) first
  for (int d = 0; d < 8; d++) send(d + 1, help[d]);
  Serial.println("help");
  delay(500);
}

uint32_t count = 0;

void loop() {
  uint32_t v = count;
  for (int d = 0; d < 8; d++) {
    send(d + 1, (d == 0 || v > 0) ? v % 10 : 15);
    v /= 10;
  }
  Serial.print("n=");
  Serial.println(count);
  count++;
  delay(100);
}
