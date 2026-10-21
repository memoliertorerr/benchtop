# extui.S — EXTUI at every width 1–16 on a2 = 0xa5c3f00f, shift = (3 × width) mod (33 − width)
# (the assembler requires shift + width ≤ 32); results in order of width. The test checks them
# against (a2 >>> shift) & (2^width − 1) computed in JS.
    .include "harness.inc"
    HARNESS_START
    RESULTS_START
    movi a2, 0xa5c3f00f
    extui a4, a2, 3, 1
    RESULT a4
    extui a4, a2, 6, 2
    RESULT a4
    extui a4, a2, 9, 3
    RESULT a4
    extui a4, a2, 12, 4
    RESULT a4
    extui a4, a2, 15, 5
    RESULT a4
    extui a4, a2, 18, 6
    RESULT a4
    extui a4, a2, 21, 7
    RESULT a4
    extui a4, a2, 24, 8
    RESULT a4
    extui a4, a2, 3, 9
    RESULT a4
    extui a4, a2, 7, 10
    RESULT a4
    extui a4, a2, 11, 11
    RESULT a4
    extui a4, a2, 15, 12
    RESULT a4
    extui a4, a2, 19, 13
    RESULT a4
    extui a4, a2, 4, 14
    RESULT a4
    extui a4, a2, 9, 15
    RESULT a4
    extui a4, a2, 14, 16
    RESULT a4
    HARNESS_END
