/**
 * The ESP32 LX6's 32 interrupts (core-isa.h): level and type of each, and the masks the core
 * uses to decide what it may take. Level-type external interrupts follow their line; edge-type
 * and software ones are latched in INTERRUPT (INTSET/INTCLEAR); timers (6, 15, 16) latch when
 * CCOUNT reaches CCOMPARE0/1/2 and clear when that CCOMPARE is written; 14 is the NMI.
 */

export const INT_LEVEL: readonly number[] = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 7, 3, 5, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 3, 4, 3, 4, 5,
];

export const INT_MASK = {
  SOFTWARE: 0x20000080,
  EXTERN_EDGE: 0x50400400,
  EXTERN_LEVEL: 0x8fbe333f,
  TIMER: 0x00018040,
  NMI: 0x00004000,
  PROFILING: 0x00000800,
} as const;

/** INTSET/INTCLEAR reach only these bits. */
export const INT_SETTABLE = INT_MASK.SOFTWARE | INT_MASK.EXTERN_EDGE;

/** The timer interrupt of CCOMPARE0/1/2. */
export const TIMER_INTERRUPT: readonly number[] = [6, 15, 16];

/** ABOVE[l]: the interrupts whose level is greater than l (l = 0–15). */
export const ABOVE: Uint32Array = Uint32Array.from({ length: 16 }, (_, l) => {
  let mask = 0;
  for (let i = 0; i < 32; i++) if (INT_LEVEL[i] > l) mask |= 1 << i;
  return mask >>> 0;
});

/** LEVEL_MASK[l]: the interrupts at exactly level l. */
export const LEVEL_MASK: Uint32Array = Uint32Array.from({ length: 8 }, (_, l) => {
  let mask = 0;
  for (let i = 0; i < 32; i++) if (INT_LEVEL[i] === l) mask |= 1 << i;
  return mask >>> 0;
});
