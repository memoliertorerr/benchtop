// Pico float math (BT60): float and double results through the bootrom's soft-float tables,
// printed on Serial1 (UART0) once. The test computes the same values on the host.
void setup() {
  Serial1.begin(115200);
  volatile float a = 2.5f, b = 0.75f;
  volatile double c = 1.0 / 3.0, d = 2.0;
  Serial1.println(a * b, 6);
  Serial1.println(a / b, 6);
  Serial1.println(sqrtf(a), 6);
  Serial1.println(sinf(b), 6);
  Serial1.println(cosf(b), 6);
  Serial1.println(expf(b), 6);
  Serial1.println(logf(a), 6);
  Serial1.println(atan2f(a, b), 6);
  Serial1.println(c * d, 10);
  Serial1.println(sqrt(d), 10);
  Serial1.println(sin(c), 10);
  Serial1.println(exp(c), 10);
  Serial1.println((int)(a * 1000.0f));
  Serial1.println((float)(d / 7.0), 6);
  Serial1.println("done");
}

void loop() {}
