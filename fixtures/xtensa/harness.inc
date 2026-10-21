# harness.inc — conventions for the Xtensa test programs in fixtures/xtensa/ (BT27; BT28 on run
# them on the emulator's CPU with no SoC around it):
#
# - Linked at 0x40080000 (IRAM). `_start` is the first instruction; HARNESS_START jumps over
#   the literal pool (--text-section-literals) and sets a1 = 0x3FFC0000 (stack top, growing down).
# - Scratch memory: 0x3FFB0000 (DRAM), `SCRATCH` below. RESULTS_START points a15 at RESULTS
#   (SCRATCH + 0x400) and each `RESULT aN` stores aN there and advances a15 by 4, so a test
#   reads the results as consecutive words.
# - A program ends with HARNESS_END (`break 1, 15`); the test then reads a2–a15 and scratch.
# - Event log (BT29's interrupt and exception programs): EVENTS_START points a15 at SCRATCH and
#   starts the log at EVENTS (SCRATCH + 0x100); the word at SCRATCH is the next free slot.
#   `EVENT code` appends a constant (clobbers a2, a3), `EVENT_REG aN` a register (clobbers a3;
#   not a3 or a15). a15 stays SCRATCH for the whole program, so handlers can log too.
# - Line 1 `# link: libgcc` links the toolchain's libgcc.a (__udivdi3, soft-float helpers …).
# - Registers: plain call0 conventions at start (WINDOWBASE 0, PS as reset leaves it); a program
#   that uses windowed calls sets PS.WOE itself.
# - GNU as transforms code: it narrows to density (.n) forms, widens instructions so `loop`
#   bodies align, and relaxes out-of-range branches. Tests assert against the committed .lst,
#   never against the .S text; exact encodings go inside `.begin no-transform` …
#   `.end no-transform`.

    .set SCRATCH, 0x3FFB0000
    .set RESULTS, 0x3FFB0400
    .set STACK_TOP, 0x3FFC0000
    .set EVENTS, 0x3FFB0100

    .macro HARNESS_START
    .text
    .global _start
    .align 4
_start:
    j .Lharness_body
    .literal_position
    .align 4
.Lharness_body:
    movi a1, STACK_TOP
    .endm

    .macro HARNESS_END
    break 1, 15
    .endm

    .macro RESULTS_START
    movi a15, RESULTS
    .endm

    .macro RESULT reg
    s32i \reg, a15, 0
    addi a15, a15, 4
    .endm

    .macro EVENTS_START
    movi a15, SCRATCH
    movi a2, EVENTS
    s32i a2, a15, 0
    .endm

    .macro EVENT_REG reg
    l32i a3, a15, 0
    s32i \reg, a3, 0
    addi a3, a3, 4
    s32i a3, a15, 0
    .endm

    .macro EVENT code
    movi a2, \code
    EVENT_REG a2
    .endm
