/*
 * hle (BT109): high-level emulation on the RP2040. The test replaces sum5, twice, outer, many,
 * scratchy, slow_twice and tick_isr with TypeScript handlers (their own bodies would return -1,
 * or set the tick count to -100000), and packages/rp2040's hle.test reads RESULTS:
 *   0  sum5(1, 2, 3, 4, 5) = 15 + 1000 (a plain handler: r0–r3 and a fifth argument on the stack)
 *   1  twice(21) = dbl(21) + dbl(22) = 86 (a generator calling the firmware twice)
 *   2  a value kept in a callee-saved register across that call: 3 · (k + 7) with k = 11 → 54
 *   3  outer(5) = nest_helper(5) + 1, nest_helper calling twice: 123 (two generators waiting)
 *   4  rec(50): 50 nested calls, then twice(1), plus one per level = 56
 *   5  sp after rec minus sp before: 0
 *   6  many() = sum6(1…6) = 21 (a call out with 2 arguments on the stack)
 *   7  scratchy() = load_word(its scratch, where it wrote 0x77) = 0x77
 *   8  ticks over a 2 ms window of 100 µs SysTicks — the handler is replaced (an exception
 *      handler: back through EXC_RETURN): 20
 *   9  slow_twice(100) on core 0 = 2 · (slow_dbl(100) + slow_dbl(101)) = 804, while core 1 runs
 *      its own slow_twice(7) = 60 (both cores inside a generator at once)
 *  10  core 1's result (60), 11 its CPUID (1)
 *  12  0xd0e: done
 * Freestanding: no SDK, no libc; linked by hle.ld.
 */
#include <stdint.h>

#define REG(a) (*(volatile uint32_t *)(a))
#define RESULTS ((volatile uint32_t *)0x20030000)
#define NOIPA __attribute__((noinline, noipa))

#define SIO_CPUID REG(0xd0000000)
#define FIFO_ST REG(0xd0000050)
#define FIFO_WR REG(0xd0000054)
#define FIFO_RD REG(0xd0000058)
#define SYST_CSR REG(0xe000e010)
#define SYST_RVR REG(0xe000e014)
#define SYST_CVR REG(0xe000e018)
#define TIMER_TIMERAWL REG(0x40054028)
#define PSM_FRCE_OFF_SET REG(0x40012004)
#define PSM_FRCE_OFF_CLR REG(0x40013004)
#define PSM_FRCE_OFF REG(0x40010004)
#define PSM_PROC1 (1u << 16)

volatile int32_t ticks;
static volatile uint32_t core1_result, core1_done;

/* Replaced: these bodies never run. */
NOIPA int32_t sum5(int32_t a, int32_t b, int32_t c, int32_t d, int32_t e) { return a + b + c + d + e - 1 - 1000; }
NOIPA int32_t twice(int32_t x) { return x - x - 1; }
NOIPA int32_t outer(int32_t x) { return x - x - 1; }
NOIPA int32_t many(void) { return -1; }
NOIPA int32_t scratchy(void) { return -1; }
NOIPA int32_t slow_twice(int32_t x) { return x - x - 1; }
NOIPA void tick_isr(void) { ticks = -100000; }

/* The firmware the handlers call. */
NOIPA int32_t dbl(int32_t x) { return 2 * x; }
NOIPA int32_t nest_helper(int32_t x) { return twice(x) + 100; }
NOIPA int32_t rec(int32_t n) { return n == 0 ? twice(1) : rec(n - 1) + 1; }
NOIPA int32_t sum6(int32_t a, int32_t b, int32_t c, int32_t d, int32_t e, int32_t f) { return a + b + c + d + e + f; }
NOIPA int32_t load_word(volatile int32_t *p) { return *p; }
NOIPA int32_t slow_dbl(int32_t x) {
  for (volatile uint32_t i = 0; i < 2000; i++) {
  }
  return 2 * x;
}

NOIPA uint32_t get_sp(void) {
  uint32_t sp;
  __asm volatile("mov %0, sp" : "=r"(sp));
  return sp;
}

static inline void sev(void) { __asm volatile("sev"); }
static inline void wfe(void) { __asm volatile("wfe"); }

static void push(uint32_t value) {
  while (!(FIFO_ST & 2)) {
  }
  FIFO_WR = value;
  sev();
}

static uint32_t pop(void) {
  while (!(FIFO_ST & 1)) wfe();
  return FIFO_RD;
}

static void wait_us(uint32_t us) {
  uint32_t t0 = TIMER_TIMERAWL;
  while (TIMER_TIMERAWL - t0 < us) {
  }
}

void core1_main(void) {
  push(SIO_CPUID);
  (void)pop(); /* go */
  core1_result = (uint32_t)slow_twice(7);
  core1_done = 1;
  sev();
  for (;;) __asm volatile("wfi");
}

static void launch(uint32_t vectors, uint32_t sp, void (*entry)(void)) {
  const uint32_t cmds[6] = { 0, 0, 1, vectors, sp, (uint32_t)entry };
  uint32_t seq = 0;
  do {
    uint32_t cmd = cmds[seq];
    if (!cmd) {
      while (FIFO_ST & 1) (void)FIFO_RD;
      sev();
    }
    push(cmd);
    uint32_t response = pop();
    seq = cmd == response ? seq + 1 : 0;
  } while (seq < 6);
}

extern const uintptr_t vectors1[];

void start(void) {
  volatile uint32_t *out = RESULTS;
  out[0] = (uint32_t)sum5(1, 2, 3, 4, 5);
  int32_t k = (int32_t)out[0] - 1004; /* 11, at run time */
  out[1] = (uint32_t)twice(21);
  out[2] = (uint32_t)(3 * (k + 7));
  out[3] = (uint32_t)outer(5);
  uint32_t sp0 = get_sp();
  out[4] = (uint32_t)rec(50);
  out[5] = get_sp() - sp0;
  out[6] = (uint32_t)many();
  out[7] = (uint32_t)scratchy();

  /* SysTick every 100 µs at 125 MHz, its handler replaced */
  ticks = 0;
  SYST_RVR = 12500 - 1;
  SYST_CVR = 0;
  SYST_CSR = 7;
  wait_us(2000);
  SYST_CSR = 0;
  out[8] = (uint32_t)ticks;

  /* core 1: launched, then both cores in slow_twice at once */
  PSM_FRCE_OFF_SET = PSM_PROC1;
  while (!(PSM_FRCE_OFF & PSM_PROC1)) {
  }
  PSM_FRCE_OFF_CLR = PSM_PROC1;
  (void)pop(); /* the bootrom's 0 */
  launch((uint32_t)vectors1, 0x20041000, core1_main);
  out[11] = pop();
  push(1); /* go */
  out[9] = (uint32_t)slow_twice(100);
  while (!core1_done) wfe();
  out[10] = core1_result;
  out[12] = 0xd0e;
  for (;;) __asm volatile("wfi");
}

/* Core 0's vector table at 0x10000100: SP, reset, …, SysTick (15). */
__attribute__((section(".vectors"), used)) const uintptr_t vectors[16] = {
  [0] = 0x20042000, [1] = (uintptr_t)start, [15] = (uintptr_t)tick_isr,
};

/* Core 1's at 0x10000200. */
__attribute__((section(".vectors1"), used)) const uintptr_t vectors1[16] = {
  [0] = 0x20041000,
};
