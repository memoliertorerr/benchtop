# harness.inc — conventions for the RISC-V test programs in fixtures/riscv/programs/ (BT64), run
# on the core with nothing around it (packages/riscv/src/test-support/bare-machine.test-helper.ts):
#
# - Linked at 0x80000000; `_start` is the first instruction. RAM is 0x80000000–0x8003FFFF;
#   HARNESS_START sets sp = 0x80040000 (STACK_TOP) and tp = OUT.
# - Inputs at IN (0x80010000), which the test writes before running: by convention the count
#   first, then the values. Outputs at OUT (0x80020000, up to 96 KB below the stack):
#   `OUTPUT reg` stores a register at tp and advances tp by 4, so a test reads consecutive
#   words.
# - MMIO (0x10000000): +0 a console byte, +4 exit with a code (EXIT code), +8 the interrupt lines
#   (mip bits) the machine drives from then on (LINES reg).
# - Assembled for the Hazard3 ISA (scripts/riscv-corpus.ts RISCV_MARCH) by the arduino-pico
#   core's binutils 2.43. GNU as compresses where it can (RVC, Zcb); exact encodings go inside
#   `.option push`, `.option norvc` … `.option pop`. What it doesn't know — Hazard3's
#   h3.bextm/h3.bextmi and Zcmp's cm.mvsa01/cm.mva01s — comes from the macros below, encoded
#   from the specs' tables with `.insn`; tests assert against the committed .lst, never against
#   the .S text.

    .equ IN, 0x80010000
    .equ OUT, 0x80020000
    .equ STACK_TOP, 0x80040000
    .equ MMIO, 0x10000000

    .macro HARNESS_START
    .text
    .global _start
_start:
    li sp, STACK_TOP
    li tp, OUT
    .endm

    .macro OUTPUT reg
    sw \reg, 0(tp)
    addi tp, tp, 4
    .endm

    .macro EXIT code
    li t6, MMIO
    li t5, \code
    sw t5, 4(t6)
1:  j 1b
    .endm

    .macro LINES reg
    li t6, MMIO
    sw \reg, 8(t6)
    .endm

# Hazard3 Xh3bextm (custom-0): bits 28:26 hold size − 1.
    .macro h3_bextm rd, rs1, rs2, size
    .insn r 0x0b, 0, (\size - 1) << 1, \rd, \rs1, \rs2
    .endm
    .macro h3_bextmi rd, rs1, shamt, size
    .insn i 0x0b, 4, \rd, \rs1, ((\size - 1) << 6) | \shamt
    .endm

# Zcmp's register moves (the assembler doesn't know them): sreg 0–7 = s0, s1, s2 … s7.
    .macro cm_mvsa01 r1s, r2s
    .insn 2, 0xac22 | (\r1s << 7) | (\r2s << 2)
    .endm
    .macro cm_mva01s r1s, r2s
    .insn 2, 0xac62 | (\r1s << 7) | (\r2s << 2)
    .endm
