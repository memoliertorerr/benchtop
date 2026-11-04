// rsa-kat — tests assert (BT103): mbedTLS's bignum on the ESP32's RSA accelerator (Arduino-ESP32
// 2.0.17 builds it with CONFIG_MBEDTLS_HARDWARE_MPI; IDF's port exponentiates with hardware
// Montgomery multiplications). Numbers come from a 32-bit LCG (seed·1103515245 + 12345, byte =
// state >> 16) so the test rebuilds them with BigInt: for 512, 1024, 2048 and 3072 bits an odd
// modulus M (top bit set), X < M and exponents 65537 and a full-length E; it prints X^E mod M
// ("exp <bits> <e> <hex>"), and A·B for 512-, 1024- and 2048-bit A, B ("mul <bits> <hex>"),
// uppercase hex as mbedtls_mpi_write_string writes it. Ends with "kat done".
#include <mbedtls/bignum.h>

static uint32_t lcg;
static uint8_t buf[512];
static char text[2200];

static void fill(mbedtls_mpi *x, size_t bytes, bool top, bool odd) {
  for (size_t i = 0; i < bytes; i++) {
    lcg = lcg * 1103515245u + 12345u;
    buf[i] = (uint8_t)(lcg >> 16);
  }
  if (top) buf[0] |= 0x80;
  else buf[0] &= 0x7f;
  if (odd) buf[bytes - 1] |= 1;
  mbedtls_mpi_read_binary(x, buf, bytes);
}

static void print(const char *label, int bits, const char *e, const mbedtls_mpi *x) {
  size_t n;
  if (mbedtls_mpi_write_string(x, 16, text, sizeof text, &n) != 0) {
    Serial.printf("%s %d %s ERROR\n", label, bits, e);
    return;
  }
  if (e[0] != 0) Serial.printf("%s %d %s %s\n", label, bits, e, text);
  else Serial.printf("%s %d %s\n", label, bits, text);
}

void setup() {
  Serial.begin(115200);
  mbedtls_mpi m, x, e, z, a, b;
  mbedtls_mpi_init(&m);
  mbedtls_mpi_init(&x);
  mbedtls_mpi_init(&e);
  mbedtls_mpi_init(&z);
  mbedtls_mpi_init(&a);
  mbedtls_mpi_init(&b);
  const int sizes[] = {512, 1024, 2048, 3072};
  for (int bits : sizes) {
    lcg = (uint32_t)bits;
    size_t bytes = bits / 8;
    fill(&m, bytes, true, true);
    fill(&x, bytes, false, false);  // top bit clear: X < M
    mbedtls_mpi_lset(&e, 65537);
    int r = mbedtls_mpi_exp_mod(&z, &x, &e, &m, NULL);
    if (r != 0) Serial.printf("exp %d 65537 ERROR %d\n", bits, r);
    else print("exp", bits, "65537", &z);
    fill(&e, bytes, true, false);
    r = mbedtls_mpi_exp_mod(&z, &x, &e, &m, NULL);
    if (r != 0) Serial.printf("exp %d full ERROR %d\n", bits, r);
    else print("exp", bits, "full", &z);
  }
  const int mulSizes[] = {512, 1024, 2048};
  for (int bits : mulSizes) {
    lcg = (uint32_t)bits * 7u;
    fill(&a, bits / 8, true, false);
    fill(&b, bits / 8, true, false);
    mbedtls_mpi_mul_mpi(&z, &a, &b);
    print("mul", bits, "", &z);
  }
  Serial.println("kat done");
}

void loop() {
  delay(1000);
}
