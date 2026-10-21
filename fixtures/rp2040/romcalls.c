/*
 * romcalls (BT60): calls every bootrom function the way the SDK finds them — the 16-bit table
 * pointers at 0x14/0x16 and rom_table_lookup at 0x18 — and stores the results in RESULTS for
 * rp2040's bootrom test. Freestanding: no SDK, no libc; linked by romcalls.ld at flash
 * 0x10000000 with its vector table at 0x10000100, where the bootrom's direct boot looks.
 */
#include <stdint.h>

typedef void *(*lookup_fn)(const uint16_t *table, uint32_t code);
typedef float (*ff2)(float, float);
typedef float (*ff1)(float);
typedef double (*dd2)(double, double);
typedef double (*dd1)(double);

#define ROM_HWORD(a) ((uintptr_t)(*(const uint16_t *)(uintptr_t)(a)))
#define CODE(a, b) ((uint32_t)(a) | ((uint32_t)(b) << 8))

/* The test reads these: results[i] in order (see romcalls.test in packages/rp2040). */
#define RESULTS ((volatile uint32_t *)0x20030000)
#define SCRATCH ((uint8_t *)0x20031000)

static void *lookup(uintptr_t table_at, uint32_t code) {
  lookup_fn fn = (lookup_fn)ROM_HWORD(0x18);
  return fn((const uint16_t *)ROM_HWORD(table_at), code);
}

static inline uint32_t bits(float f) {
  union { float f; uint32_t u; } v = { f };
  return v.u;
}

static inline uint64_t dbits(double d) {
  union { double d; uint64_t u; } v = { d };
  return v.u;
}

void start(void) {
  uint32_t n = 0;
  volatile uint32_t *out = RESULTS;
  const uint8_t *rom = (const uint8_t *)0;
  out[n++] = rom[0x10] | rom[0x11] << 8 | rom[0x12] << 16 | (uint32_t)rom[0x13] << 24; /* 0: 'M' 'u' 1 version */

  uint32_t (*popcount)(uint32_t) = lookup(0x14, CODE('P', '3'));
  uint32_t (*reverse)(uint32_t) = lookup(0x14, CODE('R', '3'));
  uint32_t (*clz)(uint32_t) = lookup(0x14, CODE('L', '3'));
  uint32_t (*ctz)(uint32_t) = lookup(0x14, CODE('T', '3'));
  out[n++] = popcount(0xf0f00001u);   /* 1 */
  out[n++] = reverse(0x00000001u);    /* 2 */
  out[n++] = clz(0x00010000u);        /* 3 */
  out[n++] = clz(0);                  /* 4 */
  out[n++] = ctz(0x00010000u);        /* 5 */
  out[n++] = ctz(0);                  /* 6 */

  uint8_t *(*memset_)(uint8_t *, uint8_t, uint32_t) = lookup(0x14, CODE('M', 'S'));
  uint32_t *(*memset4)(uint32_t *, uint8_t, uint32_t) = lookup(0x14, CODE('S', '4'));
  uint8_t *(*memcpy_)(uint8_t *, const uint8_t *, uint32_t) = lookup(0x14, CODE('M', 'C'));
  uint8_t *(*memcpy44)(uint32_t *, const uint32_t *, uint32_t) = lookup(0x14, CODE('C', '4'));
  out[n++] = (uint32_t)memset_(SCRATCH + 1, 0xab, 6) - (uint32_t)SCRATCH; /* 7: returns ptr: 1 */
  memset4((uint32_t *)(SCRATCH + 8), 0x5a, 8);
  out[n++] = *(volatile uint32_t *)(SCRATCH + 0);  /* 8 */
  out[n++] = *(volatile uint32_t *)(SCRATCH + 4);  /* 9 */
  out[n++] = *(volatile uint32_t *)(SCRATCH + 8);  /* 10 */
  memcpy_(SCRATCH + 32, (const uint8_t *)ROM_HWORD(0x14) + 0, 0); /* zero bytes: nothing */
  memcpy_(SCRATCH + 33, SCRATCH + 1, 6);
  out[n++] = *(volatile uint32_t *)(SCRATCH + 32); /* 11 */
  memcpy44((uint32_t *)(SCRATCH + 64), (const uint32_t *)0x10000100, 8); /* the vector table from flash */
  out[n++] = *(volatile uint32_t *)(SCRATCH + 64); /* 12: initial SP */

  void (*connect)(void) = lookup(0x14, CODE('I', 'F'));
  void (*exit_xip)(void) = lookup(0x14, CODE('E', 'X'));
  void (*erase)(uint32_t, uint32_t, uint32_t, uint8_t) = lookup(0x14, CODE('R', 'E'));
  void (*program)(uint32_t, const uint8_t *, uint32_t) = lookup(0x14, CODE('R', 'P'));
  void (*flush)(void) = lookup(0x14, CODE('F', 'C'));
  void (*enter_cmd)(void) = lookup(0x14, CODE('C', 'X'));
  for (int i = 0; i < 256; i++) SCRATCH[256 + i] = (uint8_t)(i ^ 0x3c);
  connect();
  exit_xip();
  erase(0x100000, 4096, 1 << 16, 0xd8);
  program(0x100000, SCRATCH + 256, 256);
  flush();
  enter_cmd();
  out[n++] = *(volatile uint32_t *)0x10100000; /* 13: programmed bytes through XIP */
  out[n++] = *(volatile uint32_t *)0x10100100; /* 14: erased, not programmed: 0xffffffff */
  program(0x100000, SCRATCH + 256 + 4, 4);    /* programs AND in: (i ^ 0x3c) & ((i + 4) ^ 0x3c) */
  out[n++] = *(volatile uint32_t *)0x10100000; /* 15 */

  out[n++] = lookup(0x14, CODE('Z', 'Z')) == 0; /* 16: an unknown code finds nothing */
  out[n++] = (uint32_t)lookup(0x16, CODE('C', 'R')) != 0; /* 17: the copyright string exists */
  const uint32_t *sf = lookup(0x16, CODE('S', 'F'));
  const uint32_t *sd = lookup(0x16, CODE('S', 'D'));
  out[n++] = ((const uint8_t *)sf)[-2];  /* 18: table size in words (the SDK checks ≥ 32) */

  /* 19–30: single precision through the table */
  out[n++] = bits(((ff2)sf[0x00 / 4])(1.5f, 2.25f));
  out[n++] = bits(((ff2)sf[0x04 / 4])(1.5f, 2.25f));
  out[n++] = bits(((ff2)sf[0x08 / 4])(1.5f, -2.25f));
  out[n++] = bits(((ff2)sf[0x0c / 4])(1.0f, 3.0f));
  out[n++] = bits(((ff1)sf[0x18 / 4])(2.0f));
  out[n++] = ((int (*)(float))sf[0x1c / 4])(-2.5f);
  out[n++] = ((int (*)(float, int))sf[0x20 / 4])(0.5f, 16);
  out[n++] = ((uint32_t (*)(float))sf[0x24 / 4])(-1.0f);
  out[n++] = bits(((float (*)(int))sf[0x2c / 4])(-7));
  out[n++] = bits(((ff1)sf[0x40 / 4])(0.5f));
  out[n++] = bits(((ff1)sf[0x50 / 4])(0.0f));
  out[n++] = ((int (*)(float, float))sf[0x54 / 4])(1.0f, 2.0f);
  /* 31–33: double precision */
  uint64_t d = dbits(((dd2)sd[0x00 / 4])(0.1, 0.2));
  out[n++] = (uint32_t)d;
  out[n++] = (uint32_t)(d >> 32);
  out[n++] = bits(((float (*)(double))sd[0x7c / 4])(1.0 / 3.0));
  out[n++] = 0xd0e; /* 34: done marker */
  for (;;) __asm volatile("wfi");
}

/* The vector table at 0x10000100: initial SP and the reset handler. */
__attribute__((section(".vectors"), used)) const uintptr_t vectors[2] = { 0x20042000, (uintptr_t)start };
