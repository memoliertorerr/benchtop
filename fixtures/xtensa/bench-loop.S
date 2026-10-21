# bench-loop.S — 10,000,000 iterations of an ALU loop (addi; bne): 20,000,000 instructions.
# Ends with a2 = 10000000 (0x989680).
    .include "harness.inc"
    HARNESS_START
    movi a2, 0
    movi a3, 10000000
.Lloop:
    addi a2, a2, 1
    bne a2, a3, .Lloop
    HARNESS_END
