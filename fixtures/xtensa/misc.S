# misc.S — NSA/NSAU, MIN/MAX/MINU/MAXU, CLAMPS and SEXT at every width 7–22, ABS and NEG at
# INT_MIN. Results with RESULT, in order (hand-derived):
#
#   nsa 0 → 31; nsa −1 → 31; nsa 1 → 30; nsa 0x7fffffff → 0; nsa 0x80000000 → 0;
#   nsa 0x00ffff00 → 7; nsa 0xffff0000 → 15 (16 leading sign bits, minus one)
#   nsau 0 → 32; nsau 1 → 31; nsau 0x80000000 → 0; nsau 0x0000ffff → 16
#   min −1, 1 → −1; max −1, 1 → 1; minu 0xffffffff, 1 → 1; maxu 0xffffffff, 1 → 0xffffffff
#   then for w = 7 … 22 (16 groups of 5): clamps 0x7fffffff, w → 2^w − 1; clamps 0x80000000, w
#   → −2^w; clamps 100, w → 100; sext 0xaaaaaaaa, w and sext 0x55555555, w → the low w + 1
#   bits sign-extended from bit w (0xaaaaaaaa has bit w set exactly when w is odd)
#   abs 0x80000000 → 0x80000000; abs −5 → 5; neg 0x80000000 → 0x80000000; neg 5 → −5

    .include "harness.inc"

    .macro OP2 op, a
    movi a2, \a
    \op a4, a2
    RESULT a4
    .endm

    .macro OP3 op, a, b
    movi a2, \a
    movi a3, \b
    \op a4, a2, a3
    RESULT a4
    .endm

    .macro WIDTH w
    movi a2, 0x7fffffff
    clamps a4, a2, \w
    RESULT a4
    movi a2, 0x80000000
    clamps a4, a2, \w
    RESULT a4
    movi a2, 100
    clamps a4, a2, \w
    RESULT a4
    movi a2, 0xaaaaaaaa
    sext a4, a2, \w
    RESULT a4
    movi a2, 0x55555555
    sext a4, a2, \w
    RESULT a4
    .endm

    HARNESS_START
    RESULTS_START
    OP2 nsa, 0
    OP2 nsa, -1
    OP2 nsa, 1
    OP2 nsa, 0x7fffffff
    OP2 nsa, 0x80000000
    OP2 nsa, 0x00ffff00
    OP2 nsa, 0xffff0000
    OP2 nsau, 0
    OP2 nsau, 1
    OP2 nsau, 0x80000000
    OP2 nsau, 0x0000ffff
    OP3 min, -1, 1
    OP3 max, -1, 1
    OP3 minu, 0xffffffff, 1
    OP3 maxu, 0xffffffff, 1
    WIDTH 7
    WIDTH 8
    WIDTH 9
    WIDTH 10
    WIDTH 11
    WIDTH 12
    WIDTH 13
    WIDTH 14
    WIDTH 15
    WIDTH 16
    WIDTH 17
    WIDTH 18
    WIDTH 19
    WIDTH 20
    WIDTH 21
    WIDTH 22
    movi a2, 0x80000000
    abs a4, a2
    RESULT a4
    movi a2, -5
    abs a4, a2
    RESULT a4
    movi a2, 0x80000000
    neg a4, a2
    RESULT a4
    movi a2, 5
    neg a4, a2
    RESULT a4
    HARNESS_END
