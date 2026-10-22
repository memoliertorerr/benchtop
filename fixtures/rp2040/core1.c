/*
 * core1 (BT80): both cores of the RP2040, without the SDK. Core 0 resets core 1 through the PSM
 * and launches it with the bootrom's FIFO protocol (as multicore_launch_core1_raw does), then
 * checks, phase by phase, what packages/rp2040's core1.test reads back from RESULTS:
 *   0      core 0's SIO CPUID (0)
 *   1      core 1's CPUID, sent through the FIFO (1)
 *   2–5    10, 20, 30, 40 pushed to core 1, echoed + 1
 *   6, 7   SysTick interrupts over a 10 ms window: core 0's (100 µs reload) and core 1's (200 µs)
 *   8, 9   TIMER alarm 0's interrupts: on core 1, which enabled it (1), on core 0, which didn't (0)
 *   10     core 0 asleep in WFE, woken by core 1's SEV after core 1 sets a flag (the flag: 1)
 *   11, 12 FIFO_ST after reading an empty FIFO (RDY | ROE), after writing it to clear (RDY)
 *   13     FIFO_ST after 9 words to a core 1 that stopped reading (WOF, not RDY)
 *   14     the 0 core 1's bootrom pushes when released from reset
 *   15     the word a second launch (another entry) sends (0x22)
 *   16     0xd0e: done
 * Freestanding: no SDK, no libc; linked by core1.ld.
 */
#include <stdint.h>

#define REG(a) (*(volatile uint32_t *)(a))
#define RESULTS ((volatile uint32_t *)0x20030000)

#define SIO_CPUID REG(0xd0000000)
#define FIFO_ST REG(0xd0000050)
#define FIFO_WR REG(0xd0000054)
#define FIFO_RD REG(0xd0000058)
#define SYST_CSR REG(0xe000e010)
#define SYST_RVR REG(0xe000e014)
#define SYST_CVR REG(0xe000e018)
#define NVIC_ISER REG(0xe000e100)
#define TIMER_ALARM0 REG(0x40054010)
#define TIMER_TIMERAWL REG(0x40054028)
#define TIMER_INTR REG(0x40054034)
#define TIMER_INTE REG(0x40054038)
#define PSM_FRCE_OFF_SET REG(0x40012004)
#define PSM_FRCE_OFF_CLR REG(0x40013004)
#define PSM_FRCE_OFF REG(0x40010004)
#define PSM_PROC1 (1u << 16)

static volatile uint32_t ticks0, ticks1, timer0, timer1, flag;

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

static void systick(uint32_t reload) {
  SYST_RVR = reload;
  SYST_CVR = 0;
  SYST_CSR = 7; /* enable, interrupt, processor clock */
}

void isr_systick0(void) { ticks0++; }
void isr_systick1(void) { ticks1++; }
void isr_timer0(void) { timer0++; TIMER_INTR = 1; }
void isr_timer1(void) { timer1++; TIMER_INTR = 1; }

void core1_main(void) {
  push(SIO_CPUID);
  systick(25000 - 1); /* 200 µs at 125 MHz */
  NVIC_ISER = 1u << 0; /* TIMER_IRQ_0 on this core only */
  for (;;) {
    uint32_t v = pop();
    if (v == 0xbeef) {
      wait_us(50);
      flag = 1;
      sev();
    } else if (v == 0x5709) {
      for (;;) __asm volatile("wfi"); /* stops reading the FIFO */
    } else {
      push(v + 1);
    }
  }
}

void core1_second(void) {
  push(0x22);
  for (;;) __asm volatile("wfi");
}

static void reset_core1(volatile uint32_t *out) {
  PSM_FRCE_OFF_SET = PSM_PROC1;
  while (!(PSM_FRCE_OFF & PSM_PROC1)) {
  }
  PSM_FRCE_OFF_CLR = PSM_PROC1;
  *out = pop(); /* the bootrom's 0 */
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
  uint32_t scratch;
  out[0] = SIO_CPUID;
  reset_core1(&scratch);
  launch((uint32_t)vectors1, 0x20041000, core1_main);
  out[1] = pop();
  for (uint32_t i = 1; i <= 4; i++) {
    push(i * 10);
    out[1 + i] = pop();
  }

  /* SysTick on each core, counted over the same 10 ms */
  systick(12500 - 1); /* 100 µs */
  wait_us(1000);
  uint32_t a0 = ticks0, a1 = ticks1;
  wait_us(10000);
  out[6] = ticks0 - a0;
  out[7] = ticks1 - a1;
  SYST_CSR = 0;

  /* TIMER alarm 0: core 1 enabled its interrupt, core 0 didn't */
  TIMER_INTE = 1;
  TIMER_ALARM0 = TIMER_TIMERAWL + 100;
  wait_us(300);
  out[8] = timer1;
  out[9] = timer0;
  TIMER_INTE = 0;

  /* core 0 sleeps in WFE (nothing else can wake it now) until core 1's SEV */
  push(0xbeef);
  while (!flag) wfe();
  out[10] = flag;

  /* FIFO_ST's sticky flags */
  (void)FIFO_RD; /* empty: ROE */
  out[11] = FIFO_ST & 0xf;
  FIFO_ST = 0xff;
  out[12] = FIFO_ST & 0xf;
  push(0x5709);
  wait_us(50); /* core 1 took it and stopped reading */
  for (uint32_t i = 0; i < 9; i++) FIFO_WR = i; /* the 9th doesn't fit: WOF */
  out[13] = FIFO_ST & 0xf;
  FIFO_ST = 0xff;

  /* reset core 1 and launch it again elsewhere */
  reset_core1(&out[14]);
  launch((uint32_t)vectors1, 0x20041000, core1_second);
  out[15] = pop();
  out[16] = 0xd0e;
  for (;;) __asm volatile("wfi");
}

/* Core 0's vector table at 0x10000100: SP, reset, …, SysTick (15), TIMER_IRQ_0 (16). */
__attribute__((section(".vectors"), used)) const uintptr_t vectors[17] = {
  [0] = 0x20042000, [1] = (uintptr_t)start, [15] = (uintptr_t)isr_systick0, [16] = (uintptr_t)isr_timer0,
};

/* Core 1's at 0x10000200. */
__attribute__((section(".vectors1"), used)) const uintptr_t vectors1[17] = {
  [0] = 0x20041000, [15] = (uintptr_t)isr_systick1, [16] = (uintptr_t)isr_timer1,
};
