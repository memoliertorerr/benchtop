# smoke.S — the first program through the pipeline: a2 = 1 + 2 + … + 10 = 55, also stored at
# SCRATCH; a3 ends at 11.
    .include "harness.inc"
    HARNESS_START
    movi a2, 0
    movi a3, 1
    movi a4, 10
.Lloop:
    add a2, a2, a3
    addi a3, a3, 1
    bge a4, a3, .Lloop
    movi a5, SCRATCH
    s32i a2, a5, 0
    HARNESS_END
