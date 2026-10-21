# window-recurse.S — rec(n) = n == 1 ? 1 : n + rec(n − 1) through call8, depth 40 (frames F1–F40
# below main's F0). 64 registers are 16 window quarters and a call8 frame owns 2, so 8 frames fit:
# frame F_k (k = 7–39) writing its argument a10 touches the quarters of F_(k−7) → 33 window
# overflows (OF8: the next frame start is 2 quarters on), spilling F0–F32 in order. Returning,
# F33–F1 each find their caller spilled → 33 underflows (UF8). Ends with a2 = 820,
# WINDOWBASE 0, WINDOWSTART 1 (as at entry), MISC0 = 33 overflows, MISC1 = 33 underflows.
    .include "harness.inc"
    .include "vectors.inc"
    VECTORS
    # PS: WOE = 1, UM = 1, EXCM = 0, INTLEVEL = 0. WINDOWBASE 0 and WINDOWSTART 1 from reset.
    movi a2, 0x40020
    wsr a2, ps
    rsync
    movi a10, 40
    call8 rec
    mov a2, a10
    rsr a3, windowbase
    rsr a4, windowstart
    rsr a5, misc0
    rsr a6, misc1
    HARNESS_END

    .align 4
rec:
    entry a1, 32
    beqi a2, 1, 1f
    addi a10, a2, -1
    call8 rec
    add a2, a2, a10
1:  retw
