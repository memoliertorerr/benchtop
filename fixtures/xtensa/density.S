# density.S — every Code Density form. Results, in order:
#   movi.n −32 = 0xffffffe0 · movi.n 95 · mov.n 7 · add.n 7 + 7 = 14 · addi.n −1: 13 ·
#   addi.n 15: 28 · s32i.n / l32i.n at offset 60: 28 · beqz.n taken: 1 · beqz.n not taken: 2 ·
#   bnez.n taken: 3 · bnez.n not taken: 4 · nop.n changes nothing: 4 · call0 to a ret.n
#   subroutine that sets a9 = 77: 77
    .include "harness.inc"
    HARNESS_START
    RESULTS_START
    movi.n a2, -32
    RESULT a2
    movi.n a2, 95
    RESULT a2
    movi.n a3, 7
    mov.n a4, a3
    RESULT a4
    add.n a5, a3, a4
    RESULT a5
    addi.n a5, a5, -1
    RESULT a5
    addi.n a5, a5, 15
    RESULT a5
    movi a6, SCRATCH
    s32i.n a5, a6, 60
    l32i.n a7, a6, 60
    RESULT a7
    movi.n a8, 0
    movi.n a10, 0
    beqz.n a8, 1f
    j 9f
1:  addi.n a10, a10, 1
    RESULT a10
    beqz.n a3, 9f
    addi.n a10, a10, 1
    RESULT a10
    bnez.n a3, 2f
    j 9f
2:  addi.n a10, a10, 1
    RESULT a10
    bnez.n a8, 9f
    addi.n a10, a10, 1
    RESULT a10
    nop.n
    RESULT a10
    call0 sub
    RESULT a9
    HARNESS_END
9:  movi a2, 0xbad
    HARNESS_END

    .align 4
sub:
    movi.n a9, 77
    ret.n
