// mega/interrupts — tests assert: external interrupts from both control registers and a pin
// change group: falling edges on D3 (INT5, EICRB) and D19 (INT2, EICRA), and any change on A8
// (PK0, PCINT16), counted and printed every 100 ms at 115200 baud as "int5=N int2=N pcint=N".
volatile uint16_t int5 = 0, int2 = 0, pcint = 0;

void onInt5() { int5++; }
void onInt2() { int2++; }
ISR(PCINT2_vect) { pcint++; }

void setup() {
  Serial.begin(115200);
  pinMode(3, INPUT_PULLUP);
  pinMode(19, INPUT_PULLUP);
  pinMode(A8, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(3), onInt5, FALLING);
  attachInterrupt(digitalPinToInterrupt(19), onInt2, FALLING);
  PCMSK2 = 1 << PCINT16;
  PCICR = 1 << PCIE2;
}

void loop() {
  noInterrupts();
  uint16_t a = int5, b = int2, c = pcint;
  interrupts();
  Serial.print("int5=");
  Serial.print(a);
  Serial.print(" int2=");
  Serial.print(b);
  Serial.print(" pcint=");
  Serial.println(c);
  delay(100);
}
