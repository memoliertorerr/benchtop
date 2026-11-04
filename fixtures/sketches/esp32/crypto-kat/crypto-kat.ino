// crypto-kat — tests assert (BT102): mbedTLS's hashes and ciphers on the ESP32's accelerators
// (Arduino-ESP32 2.0.17 builds them with CONFIG_MBEDTLS_HARDWARE_SHA/AES), printed as hex for the
// test to compare with Node's crypto: SHA-1/256/384/512 of "abc", of an empty message and of
// 1000 bytes (several blocks, CONTINUE), then AES-128/192/256 ECB on FIPS-197's block and
// AES-256 CBC over 64 bytes, each decrypted back. Ends with "kat done".
#include <mbedtls/sha1.h>
#include <mbedtls/sha256.h>
#include <mbedtls/sha512.h>
#include <mbedtls/aes.h>

static void hex(const char *label, const uint8_t *data, size_t length) {
  Serial.print(label);
  Serial.print(' ');
  for (size_t i = 0; i < length; i++) Serial.printf("%02x", data[i]);
  Serial.println();
}

static uint8_t big[1000];

static void hashes(const char *name, const uint8_t *data, size_t length) {
  uint8_t out[64];
  char label[32];
  mbedtls_sha1_ret(data, length, out);
  snprintf(label, sizeof label, "sha1 %s", name);
  hex(label, out, 20);
  mbedtls_sha256_ret(data, length, out, 0);
  snprintf(label, sizeof label, "sha256 %s", name);
  hex(label, out, 32);
  mbedtls_sha512_ret(data, length, out, 1);
  snprintf(label, sizeof label, "sha384 %s", name);
  hex(label, out, 48);
  mbedtls_sha512_ret(data, length, out, 0);
  snprintf(label, sizeof label, "sha512 %s", name);
  hex(label, out, 64);
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 1000; i++) big[i] = (uint8_t)(i * 7 + 3);
  hashes("abc", (const uint8_t *)"abc", 3);
  hashes("empty", (const uint8_t *)"", 0);
  hashes("1000", big, sizeof big);

  // FIPS-197 appendix C: plaintext 00112233…ff, keys 000102…
  uint8_t key[32];
  for (int i = 0; i < 32; i++) key[i] = i;
  const uint8_t plain[16] = {0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff};
  for (int bits = 128; bits <= 256; bits += 64) {
    mbedtls_aes_context aes;
    uint8_t cipher[16], back[16];
    char label[24];
    mbedtls_aes_init(&aes);
    mbedtls_aes_setkey_enc(&aes, key, bits);
    mbedtls_aes_crypt_ecb(&aes, MBEDTLS_AES_ENCRYPT, plain, cipher);
    mbedtls_aes_setkey_dec(&aes, key, bits);
    mbedtls_aes_crypt_ecb(&aes, MBEDTLS_AES_DECRYPT, cipher, back);
    mbedtls_aes_free(&aes);
    snprintf(label, sizeof label, "aes%d", bits);
    hex(label, cipher, 16);
    snprintf(label, sizeof label, "aes%d back", bits);
    hex(label, back, 16);
  }
  {
    mbedtls_aes_context aes;
    uint8_t iv[16], cipher[64], back[64];
    for (int i = 0; i < 16; i++) iv[i] = 0xa0 + i;
    mbedtls_aes_init(&aes);
    mbedtls_aes_setkey_enc(&aes, key, 256);
    mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_ENCRYPT, 64, iv, big, cipher);
    for (int i = 0; i < 16; i++) iv[i] = 0xa0 + i;
    mbedtls_aes_setkey_dec(&aes, key, 256);
    mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_DECRYPT, 64, iv, cipher, back);
    mbedtls_aes_free(&aes);
    hex("cbc256", cipher, 64);
    Serial.println(memcmp(back, big, 64) == 0 ? "cbc256 back ok" : "cbc256 back BAD");
  }
  Serial.println("kat done");
}

void loop() {
  delay(1000);
}
