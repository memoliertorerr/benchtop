# window-recurse12.S — sum 1..20 through call12, depth 20. A call12 frame owns 3 quarters (5 fit,
# with 1 to spare): tracing WINDOWSTART as each frame writes its argument a14 (quarter 3) gives
# 15 overflows (all OF12) and, returning, 15 underflows (UF12). Ends with a2 = 210,
# WINDOWBASE 0, WINDOWSTART 1, MISC0 = 15, MISC1 = 15.
    .include "harness.inc"
    .include "vectors.inc"
    VECTORS
    # PS: WOE = 1, UM = 1, EXCM = 0, INTLEVEL = 0. WINDOWBASE 0 and WINDOWSTART 1 from reset.
    movi a2, 0x40020
    wsr a2, ps
    rsync
    movi a14, 20
    call12 rec12
    mov a2, a14
    rsr a3, windowbase
    rsr a4, windowstart
    rsr a5, misc0
    rsr a6, misc1
    HARNESS_END

    .align 4
rec12:
    entry a1, 48
    beqi a2, 1, 1f
    addi a14, a2, -1
    call12 rec12
    add a2, a2, a14
1:  retw
