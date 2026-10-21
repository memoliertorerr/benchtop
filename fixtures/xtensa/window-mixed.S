# window-mixed.S — a chain that cycles call4 → call8 → call12: main calls fa(30) with call4, fa
# calls fb(k − 1) with call8, fb calls fc with call12, fc calls fa with call4; each returns
# k + its callee's sum (1 at k = 1). Tracing WINDOWSTART: 23 overflows (8 OF4, 8 OF8, 7 OF12)
# and 23 underflows. Ends with a2 = 465, WINDOWBASE 0, WINDOWSTART 1, MISC0 = 23, MISC1 = 23.
# Frame sizes follow the call each function makes (vectors.inc): fa (call8) 32, fb (call12) 48,
# fc (call4) 16.
    .include "harness.inc"
    .include "vectors.inc"
    VECTORS
    # PS: WOE = 1, UM = 1, EXCM = 0, INTLEVEL = 0. WINDOWBASE 0 and WINDOWSTART 1 from reset.
    movi a2, 0x40020
    wsr a2, ps
    rsync
    movi a6, 30
    call4 fa
    mov a2, a6
    rsr a3, windowbase
    rsr a4, windowstart
    rsr a5, misc0
    rsr a6, misc1
    HARNESS_END

    .align 4
fa:
    entry a1, 32
    beqi a2, 1, 1f
    addi a10, a2, -1
    call8 fb
    add a2, a2, a10
1:  retw

    .align 4
fb:
    entry a1, 48
    beqi a2, 1, 1f
    addi a14, a2, -1
    call12 fc
    add a2, a2, a14
1:  retw

    .align 4
fc:
    entry a1, 16
    beqi a2, 1, 1f
    addi a6, a2, -1
    call4 fa
    add a2, a2, a6
1:  retw
