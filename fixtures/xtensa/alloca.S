# alloca.S — MOVSP with the caller's frame spilled raises Alloca (EXCCAUSE 5); our handler
# reloads the caller's frame and MOVSP runs again.
#
# main (F0, WINDOWBASE 0) calls f with call8 (WB 2). f calls spill(8) with call8: spill frames
# H1–H8 sit at WB 4, 6, …, 14, 0, 2. H6 (WB 14) writing a10 reaches quarter 0 → overflow of main
# (OF8); H7 (WB 0) writing a10 reaches quarter 2 → overflow of f (OF8). H8 is the leaf; H8–H2
# return to live frames; H1 returns to f, which is spilled → underflow (UF8) reloads f. Now only
# f is live (WINDOWSTART = 1 << 2) and main is still spilled, so f's `movsp a1, a6` raises Alloca:
# EPC1 = the movsp, EXCCAUSE 5. The handler sets PS.OWB = WINDOWBASE, rotates back by the
# caller's window size (8: a0's top bits are 10) and enters _WindowUnderflow8, whose RFWU marks
# main live and returns to the movsp, which now succeeds. f returns old SP − new SP = 32.
#
# Ends with: a2 = 32; a3 = WINDOWSTART f saw after the movsp (main + f: 0b101 = 5); a4, a5 =
# 0x1234, 0x5678 (main's registers, spilled and reloaded); a6 = MISC0 = 2 overflows; a7 = MISC1 =
# 2 underflows (f's and main's); a8 = 1 Alloca; a9 = EXCCAUSE = 5 (window exceptions don't write
# it); a10 = WINDOWBASE 0; a11 = WINDOWSTART 1; a12 = EPC1 = the movsp's address.

    .include "harness.inc"
    .include "vectors.inc"

    .set ALLOCA_COUNT, SCRATCH
    .set SEEN_WS, SCRATCH + 4

    VECTORS user=.Lalloca
    movi a2, 0x40020           # WOE = 1, UM = 1
    wsr a2, ps
    rsync
    movi a2, 0
    movi a3, ALLOCA_COUNT
    s32i a2, a3, 0
    movi a4, 0x1234
    movi a5, 0x5678
    call8 f
    mov a2, a10
    movi a3, SEEN_WS
    l32i a3, a3, 0
    rsr a6, misc0
    rsr a7, misc1
    movi a8, ALLOCA_COUNT
    l32i a8, a8, 0
    rsr a9, exccause
    rsr a10, windowbase
    rsr a11, windowstart
    rsr a12, epc1
    HARNESS_END

    .align 4
f:
    entry a1, 32
    mov a7, a1
    movi a10, 8
    call8 spill
    addi a6, a1, -32
    .global alloca_movsp
alloca_movsp:
    movsp a1, a6
    rsr a3, windowstart
    movi a4, SEEN_WS
    s32i a3, a4, 0
    sub a2, a7, a1
    retw

    .align 4
spill:
    entry a1, 32
    beqi a2, 1, 1f
    addi a10, a2, -1
    call8 spill
1:  retw

# The Alloca handler (user vector, PS.EXCM = 1, so no window overflow can happen in here).
.Lalloca:
    wsr a2, excsave1
    wsr a3, misc2
    wsr a4, misc3
    rsr a2, exccause
    bnei a2, 5, .Lnot_alloca
    movi a2, ALLOCA_COUNT
    l32i a3, a2, 0
    addi a3, a3, 1
    s32i a3, a2, 0
    rsr a2, ps                 # PS.OWB ← WINDOWBASE: RFWU returns to this frame
    movi a3, ~0xf00
    and a2, a2, a3
    rsr a3, windowbase
    slli a3, a3, 8
    or a2, a2, a3
    wsr a2, ps
    rsync
    rsr a2, excsave1
    rsr a3, misc2
    rsr a4, misc3
    bbci a0, 31, 4f            # a0[31:30] = 01: the caller used call4
    bbci a0, 30, 8f            # 10: call8
    rotw -3                    # 11: call12
    j _WindowUnderflow12
8:  rotw -2
    j _WindowUnderflow8
4:  rotw -1
    j _WindowUnderflow4
.Lnot_alloca:
    movi a2, 0xE340
    break 1, 15
