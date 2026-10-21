# bool.S — the Boolean option: BR (b0–b15) through WSR/RSR.BR, ANDB/ANDBC/ORB/ORBC/XORB,
# ALL4/ANY4/ALL8/ANY8, BT/BF, MOVT/MOVF. Results with RESULT, in order (hand-derived):
#
#  BR = 0x00a6 (b1, b2, b5, b7). andb b8, b1, b2 = 1; andb b9, b1, b0 = 0; andbc b10, b1, b0 =
#  1; orb b11, b0, b3 = 0; orbc b12, b0, b3 = 1; xorb b13, b1, b2 = 0; xorb b14, b1, b0 = 1
#   → BR = 0x00a6 | b8 | b10 | b12 | b14 = 0x55a6
#  BR = 0x00f0: all4 b8, b4..b7 = 1; all4 b9, b0..b3 = 0; any4 b10, b0..b3 = 0; any4 b11,
#  b4..b7 = 1; all8 b12, b0..b7 = 0; any8 b13, b0..b7 = 1 → BR = 0x29f0
#  Branches with BR = 0x0010 (b4): a mask of taken branches — bt b4 (taken, bit 0), bf b4 (not,
#  bit 1), bt b0 (not, bit 2), bf b0 (taken, bit 3) → 0b1001 = 9
#  movt a5, a6, b4 (moves 0x66 over 0x55) → 0x66; movf a5, a6, b4 → 0x55 kept; movf with b0 →
#  0x66; movt with b0 → 0x55 kept

    .include "harness.inc"

    HARNESS_START
    RESULTS_START
    movi a2, 0x00a6
    wsr a2, br
    andb b8, b1, b2
    andb b9, b1, b0
    andbc b10, b1, b0
    orb b11, b0, b3
    orbc b12, b0, b3
    xorb b13, b1, b2
    xorb b14, b1, b0
    rsr a2, br
    RESULT a2

    movi a2, 0x00f0
    wsr a2, br
    all4 b8, b4
    all4 b9, b0
    any4 b10, b0
    any4 b11, b4
    all8 b12, b0
    any8 b13, b0
    rsr a2, br
    RESULT a2

    movi a2, 0x0010
    wsr a2, br
    movi a3, 0
    bt b4, 1f
    j 2f
1:  addi a3, a3, 1
2:  bf b4, 1f
    j 2f
1:  addi a3, a3, 2
2:  bt b0, 1f
    j 2f
1:  addi a3, a3, 4
2:  bf b0, 1f
    j 2f
1:  addi a3, a3, 8
2:  RESULT a3

    movi a6, 0x66
    movi a5, 0x55
    movt a5, a6, b4
    RESULT a5
    movi a5, 0x55
    movf a5, a6, b4
    RESULT a5
    movi a5, 0x55
    movf a5, a6, b0
    RESULT a5
    movi a5, 0x55
    movt a5, a6, b0
    RESULT a5
    HARNESS_END
