# atomic.S — S32C1I against SCOMPARE1, L32AI, S32RI, S32NB. Results with RESULT, in order
# (hand-derived); WORD = SCRATCH + 0x100:
#
#  [WORD] = 5, SCOMPARE1 = 5, a2 = 9: s32c1i a2, a3, 0 succeeds → a2 = 5 (old), [WORD] = 9
#  SCOMPARE1 = 5, a2 = 7: fails → a2 = 9 (current), [WORD] = 9
#  [WORD + 4] = 1, SCOMPARE1 = 1, a2 = 2: s32c1i a2, a3, 4 → a2 = 1, [WORD + 4] = 2
#  A compare-and-swap increment loop, 10 rounds, from [WORD + 8] = 0 → [WORD + 8] = 10
#  l32ai a4, a3, 0 → 9; s32ri a5 (0x1234) at WORD + 12 → 0x1234; s32nb a5 (0x5678) at
#  WORD + 16 → 0x5678

    .include "harness.inc"

    .set WORD, SCRATCH + 0x100

    HARNESS_START
    RESULTS_START
    movi a3, WORD
    movi a4, 5
    s32i a4, a3, 0
    wsr a4, scompare1
    movi a2, 9
    s32c1i a2, a3, 0
    RESULT a2
    l32i a4, a3, 0
    RESULT a4
    movi a2, 7
    s32c1i a2, a3, 0
    RESULT a2
    l32i a4, a3, 0
    RESULT a4

    movi a4, 1
    s32i a4, a3, 4
    wsr a4, scompare1
    movi a2, 2
    s32c1i a2, a3, 4
    RESULT a2
    l32i a4, a3, 4
    RESULT a4

    movi a4, 0
    s32i a4, a3, 8
    movi a6, 10
1:  l32i a4, a3, 8                 # expected value
    wsr a4, scompare1
    addi a5, a4, 1
    s32c1i a5, a3, 8
    bne a5, a4, 1b                 # lost the race: retry (never happens here)
    addi a6, a6, -1
    bnez a6, 1b
    l32i a4, a3, 8
    RESULT a4

    l32ai a4, a3, 0
    RESULT a4
    movi a5, 0x1234
    s32ri a5, a3, 12
    l32i a4, a3, 12
    RESULT a4
    movi a5, 0x5678
    s32nb a5, a3, 16
    l32i a4, a3, 16
    RESULT a4
    HARNESS_END
