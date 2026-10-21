# window-recurse4.S — the same sum through call4, depth 40. A call4 frame owns one quarter, so 16
# fit: F_k (k = 15–39) writing a6 touches F_(k−15)'s quarter → 25 overflows (OF4), spilling
# F0–F24; returning, F25–F1 find their caller spilled → 25 underflows (UF4). Ends with a2 = 820,
# WINDOWBASE 0, WINDOWSTART 1, MISC0 = 25, MISC1 = 25.
    .include "harness.inc"
    .include "vectors.inc"
    VECTORS
    # PS: WOE = 1, UM = 1, EXCM = 0, INTLEVEL = 0. WINDOWBASE 0 and WINDOWSTART 1 from reset.
    movi a2, 0x40020
    wsr a2, ps
    rsync
    movi a6, 40
    call4 rec4
    mov a2, a6
    rsr a3, windowbase
    rsr a4, windowstart
    rsr a5, misc0
    rsr a6, misc1
    HARNESS_END

    .align 4
rec4:
    entry a1, 16
    beqi a2, 1, 1f
    addi a6, a2, -1
    call4 rec4
    add a2, a2, a6
1:  retw
