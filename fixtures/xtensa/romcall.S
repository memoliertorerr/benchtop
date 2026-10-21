# romcall.S — calls one function with up to four argument words and keeps its two result words
# (BT30's ROM libgcc differential tests run it on a BareMachine with the ROM mapped).
#
# The test writes CALL_ARGS (SCRATCH + 0x800): words 0–3 = arguments (a10–a13 at the call; a
# double or a 64-bit integer takes two, low word first), word 4 = the function's address,
# word 7 = a nesting depth. The program sets the windowed ABI up (PS.WOE = 1, PS.UM = 1,
# VECBASE = 0x40000000 so the ROM's own window vectors spill and refill frames, a pseudo caller
# SP at [a1 − 12] for the outermost frame), then `nest` recurses `depth` times through call8
# before its innermost frame `callx8`s the function — with depth ≥ 6 the call chain wraps the
# 64-register file, so window overflows and underflows go through the ROM's handlers — and
# stores a10/a11 into words 5–6. Then `break 1, 15`; the test resets PC to _start per call.

    .include "harness.inc"

    .set CALL_ARGS, SCRATCH + 0x800

    HARNESS_START
    movi a2, 0x40020               # WOE = 1, UM = 1, EXCM = 0, INTLEVEL 0
    wsr a2, ps
    movi a2, 0x40000000
    wsr a2, vecbase
    rsync
    movi a2, STACK_TOP + 0x100
    addi a3, a1, -12
    s32i a2, a3, 0
    movi a4, CALL_ARGS
    l32i a10, a4, 28
    call8 nest
    HARNESS_END

    .align 4
nest:
    entry a1, 32
    beqz a2, 1f
    addi a10, a2, -1
    call8 nest
    retw
1:  movi a4, CALL_ARGS             # a2–a7 survive callx8; a8–a15 become the callee's
    l32i a10, a4, 0
    l32i a11, a4, 4
    l32i a12, a4, 8
    l32i a13, a4, 12
    l32i a8, a4, 16
    callx8 a8
    s32i a10, a4, 20
    s32i a11, a4, 24
    retw
