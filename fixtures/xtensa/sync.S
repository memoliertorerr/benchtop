# sync.S — the synchronisation instructions and NOPs change nothing: a2–a7 keep 1–6 and
# SCRATCH keeps the 0x5a5a5a5a stored before them.
    .include "harness.inc"
    HARNESS_START
    movi a2, 1
    movi a3, 2
    movi a4, 3
    movi a5, 4
    movi a6, 5
    movi a7, 6
    movi a8, SCRATCH
    movi a9, 0x5a5a5a5a
    s32i a9, a8, 0
    isync
    rsync
    esync
    dsync
    memw
    extw
    excw
    nop
    nop.n
    HARNESS_END
