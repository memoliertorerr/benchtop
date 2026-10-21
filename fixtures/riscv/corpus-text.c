/*
 * Real compiled code for the RISC-V disassembly corpus (scripts/riscv-corpus.ts, corpus "text"):
 * links in newlib's formatted I/O, string, sorting and soft-float routines and libgcc's helpers,
 * built with the arduino-pico core's RISC-V gcc. Never runs; only its .text is compared.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <sys/lock.h>

/* This newlib uses retargetable locks (sys/lock.h): single-threaded stand-ins. */
struct __lock __lock___malloc_recursive_mutex, __lock___sfp_recursive_mutex;
void __retarget_lock_init_recursive(_LOCK_T lock) { (void)lock; }
void __retarget_lock_close_recursive(_LOCK_T lock) { (void)lock; }
void __retarget_lock_acquire_recursive(_LOCK_T lock) { (void)lock; }
void __retarget_lock_release_recursive(_LOCK_T lock) { (void)lock; }

static int cmp(const void *a, const void *b) { return *(const int *)a - *(const int *)b; }

volatile int sink;
char buffer[256];

void _start(void) {
  int values[8] = {5, 3, 9, 1, 7, 2, 8, 6};
  qsort(values, 8, sizeof values[0], cmp);
  double d = strtod("3.14159", 0) * values[3];
  long long q = (long long)values[0] * 1234567891LL / (values[1] + 1);
  snprintf(buffer, sizeof buffer, "%d %f %lld %s %x %e", values[2], d, q, "x", values[4], sqrt(d));
  sink = (int)strlen(buffer) + (int)strtol(buffer, 0, 10) + memcmp(buffer, "1", 1) + atoi(buffer + 2);
  for (;;) {}
}
