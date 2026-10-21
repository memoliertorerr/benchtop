# fpu-ops.S — FPU instructions against hand-derived IEEE results. Each check stores the result
# (bits, or an integer) and FSR (cleared before the op) with RESULT, so results come in pairs.
# FSR flags: 0x80 Inexact, 0x100 Underflow, 0x200 Overflow, 0x400 DivZero, 0x800 Invalid.
# FCR modes: 0 nearest-even, 1 toward zero, 2 toward +∞, 3 toward −∞.
#
# The FPU starts disabled (CPENABLE 0): the first FP instruction, at cp_first, raises
# Coprocessor0Disabled (EXCCAUSE 32) with EPC1 = cp_first; the handler counts it, logs EPC1 at
# CP_LOG + 4·count, sets CPENABLE bit 0 and RFE re-executes it. Later CPENABLE is cleared again
# and `rur fsr` at cp_second traps the same way (FCR/FSR are coprocessor state).
#
# 1. add.s 1 + 2^−24 (a tie): modes 0–3 → 3f800000, 3f800000, 3f800001, 3f800000; all I.
# 2. add.s 1 + 3·2^−25: → 3f800001, 3f800000, 3f800001, 3f800000; I.
# 3. add.s −1 + −2^−24: → bf800000, bf800000, bf800000, bf800001; I.
# 4. add.s MAX + MAX: → 7f800000, 7f7fffff, 7f800000, 7f7fffff; all O|I (0x280).
# 5. mul.s 2^−126 · 0.5 = 2^−127, exact denormal: 00400000, flags 0 (mode 0).
# 6. mul.s 2^−149 · 0.5 (a tie with 0): modes 0–3 → 0, 0, 00000001, 0; all U|I (0x180).
# 7. sub.s 1 − 1: mode 0 → +0, mode 3 → −0 (80000000); flags 0.
# 8. add.s ∞ + −∞ → 7fc00000 V; mul.s 0 · ∞ → 7fc00000 V; add.s qNaN 7fc12345 + 1 →
#    7fc12345, 0; add.s sNaN 7f812345 + 1 → 7fc12345 (quieted), V.
# 9. madd.s f = −(1 + 2^−11) + (1 + 2^−12)² = 2^−24 exactly (fused: an unfused multiply would
#    round the product to 1 + 2^−11 and give 0) → 33800000, 0. msub.s (1 + 2^−11) − (1 +
#    2^−12)² → b3800000, 0. madd.s 1 + 2^−12 · 2^−13 in modes 0 and 2 → 3f800000 I,
#    3f800001 I.
# 10. float.s 7, 1 → 3.5 (40600000); float.s 0x7fffffff, 0 in modes 0, 1 → 4f000000 I,
#    4effffff I; float.s −7, 2 → −1.75 (bfe00000); ufloat.s 0xffffffff, 0 in modes 0, 1 →
#    4f800000 I, 4f7fffff I; ufloat.s 0x80000000, 15 → 2^16 (47800000).
# 11. trunc.s 2.75, 0 → 2; trunc.s 2.75, 2 → 11; trunc.s −2.75, 0 → −2; round.s 2.5 → 2;
#    round.s 3.5 → 4; round.s −2.5 → −2; round.s 2.75 → 3; round.s 1.25, 1 → 2 (2.5 to even);
#    floor.s −2.5 → −3; ceil.s −2.5 → −2; floor.s 2.5 → 2; ceil.s 2.5 → 3; utrunc.s 1.5·2^31 →
#    0xc0000000 — all flags 0 — then trunc.s NaN → 7fffffff V; trunc.s 2^32 → 7fffffff V;
#    trunc.s −2^32 → 80000000 V; utrunc.s −1 → 0 V; utrunc.s −0.5 → 0, 0; trunc.s 2.75 in
#    mode 2 → 2 (FCR doesn't steer conversions to integer).
# 12. Compares into b0–b6 (un, oeq, ueq, olt, ult, ole, ule), BR & 0x7f: 1 vs 2 → 0x78; 2 vs 2
#    → 0x66; NaN vs 1 → 0x55 with V (olt/ole signal on a quiet NaN); 2 vs 1 → 0; +0 vs −0 → 0x66.
# 13. Conditional moves (f1 = 1.0, f2 = 2.0, result f1): moveqz.s a=0 → 40000000; movnez.s a=0
#    → 3f800000; movltz.s a=−1 → 40000000; movgez.s a=−1 → 3f800000; movt.s b=1 → 40000000;
#    movf.s b=1 → 3f800000. Flags 0.
# 14. Bits survive moves: wfr/rfr of sNaN 7f812345 → 7f812345; mov.s → 7f812345; abs.s of
#    ff812345 → 7f812345; neg.s of 7f812345 → ff812345 (no quieting). Flags 0.
# 15. Loads/stores from BUF = SCRATCH + 0x200 (a6, a7 = 4), post-incrementing forms store or
#    load at a6 and then add: ssi f1 (1.0) at BUF, lsi → 3f800000; ssip f2 (2.0), 8 stores at
#    BUF (a6 → BUF+8); a6 −= 8; lsip f3, 8 loads BUF → 40000000 (a6 → BUF+8), offset 8;
#    ssx f1 at BUF+12, lsx → 3f800000; ssxp f2 stores at BUF+8 (a6 → BUF+12); a6 −= 4; lsxp
#    loads BUF+8 → 40000000 (a6 → BUF+12), offset 12.
# 16. The CPENABLE traps: count 2, EPC1s = cp_first, cp_second.

    .include "harness.inc"
    .include "vectors.inc"

    .set CP_LOG, SCRATCH + 0x100
    .set BUF, SCRATCH + 0x200

    .macro MODE m
    movi a2, \m
    wur a2, fcr
    .endm

    .macro CLEAR
    movi a2, 0
    wur a2, fsr
    .endm

    .macro LOADF freg, value
    movi a2, \value
    wfr \freg, a2
    .endm

    .macro SAVE freg
    rfr a2, \freg
    RESULT a2
    rur a2, fsr
    RESULT a2
    .endm

    .macro SAVEA reg
    RESULT \reg
    rur a2, fsr
    RESULT a2
    .endm

    # One binary op in mode m: f0 ← f1 op f2.
    .macro BIN op, m, a, b
    MODE \m
    LOADF f1, \a
    LOADF f2, \b
    CLEAR
    \op f0, f1, f2
    SAVE f0
    .endm

    .macro BIN4 op, a, b
    BIN \op, 0, \a, \b
    BIN \op, 1, \a, \b
    BIN \op, 2, \a, \b
    BIN \op, 3, \a, \b
    .endm

    # f0 ← f0 ± f1·f2 (madd.s / msub.s) in mode m.
    .macro FMA op, m, acc, a, b
    MODE \m
    LOADF f0, \acc
    LOADF f1, \a
    LOADF f2, \b
    CLEAR
    \op f0, f1, f2
    SAVE f0
    .endm

    # int → float: f0 ← op(a3, imm) in mode m.
    .macro TOF op, m, value, imm
    MODE \m
    movi a3, \value
    CLEAR
    \op f0, a3, \imm
    SAVE f0
    .endm

    # float → int: a3 ← op(f1, imm) in mode m.
    .macro TOI op, m, value, imm
    MODE \m
    LOADF f1, \value
    CLEAR
    \op a3, f1, \imm
    SAVEA a3
    .endm

    # The seven compares of f1, f2 into b0–b6; saves BR & 0x7f.
    .macro CMP a, b
    LOADF f1, \a
    LOADF f2, \b
    movi a2, 0
    wsr a2, br
    CLEAR
    un.s b0, f1, f2
    oeq.s b1, f1, f2
    ueq.s b2, f1, f2
    olt.s b3, f1, f2
    ult.s b4, f1, f2
    ole.s b5, f1, f2
    ule.s b6, f1, f2
    rsr a3, br
    extui a3, a3, 0, 7
    SAVEA a3
    .endm

    # Conditional move f1 ← f2 under `op` with a3 (or b0) = cond.
    .macro CMOV op, cond, value
    LOADF f1, 0x3f800000
    LOADF f2, 0x40000000
    movi a3, \value
    CLEAR
    \op f1, f2, \cond
    SAVE f1
    .endm

    VECTORS user=.Luser
    RESULTS_START
    movi a2, 0
    movi a3, CP_LOG
    s32i a2, a3, 0
    movi a2, 0x20                  # UM = 1; the FPU is disabled (CPENABLE 0 from reset)
    wsr a2, ps
    rsync
    .global cp_first
cp_first:
    add.s f0, f0, f0

    BIN4 add.s, 0x3f800000, 0x33800000          # 1
    BIN4 add.s, 0x3f800000, 0x33c00000          # 2
    BIN4 add.s, 0xbf800000, 0xb3800000          # 3
    BIN4 add.s, 0x7f7fffff, 0x7f7fffff          # 4
    BIN mul.s, 0, 0x00800000, 0x3f000000        # 5
    BIN4 mul.s, 0x00000001, 0x3f000000          # 6
    BIN sub.s, 0, 0x3f800000, 0x3f800000        # 7
    BIN sub.s, 3, 0x3f800000, 0x3f800000
    BIN add.s, 0, 0x7f800000, 0xff800000        # 8
    BIN mul.s, 0, 0x00000000, 0x7f800000
    BIN add.s, 0, 0x7fc12345, 0x3f800000
    BIN add.s, 0, 0x7f812345, 0x3f800000
    FMA madd.s, 0, 0xbf801000, 0x3f800800, 0x3f800800   # 9
    FMA msub.s, 0, 0x3f801000, 0x3f800800, 0x3f800800
    FMA madd.s, 0, 0x3f800000, 0x39800000, 0x39000000
    FMA madd.s, 2, 0x3f800000, 0x39800000, 0x39000000

    TOF float.s, 0, 7, 1                        # 10
    TOF float.s, 0, 0x7fffffff, 0
    TOF float.s, 1, 0x7fffffff, 0
    TOF float.s, 0, -7, 2
    TOF ufloat.s, 0, 0xffffffff, 0
    TOF ufloat.s, 1, 0xffffffff, 0
    TOF ufloat.s, 0, 0x80000000, 15

    TOI trunc.s, 0, 0x40300000, 0               # 11
    TOI trunc.s, 0, 0x40300000, 2
    TOI trunc.s, 0, 0xc0300000, 0
    TOI round.s, 0, 0x40200000, 0
    TOI round.s, 0, 0x40600000, 0
    TOI round.s, 0, 0xc0200000, 0
    TOI round.s, 0, 0x40300000, 0
    TOI round.s, 0, 0x3fa00000, 1
    TOI floor.s, 0, 0xc0200000, 0
    TOI ceil.s, 0, 0xc0200000, 0
    TOI floor.s, 0, 0x40200000, 0
    TOI ceil.s, 0, 0x40200000, 0
    TOI utrunc.s, 0, 0x4f400000, 0
    TOI trunc.s, 0, 0x7fc00000, 0
    TOI trunc.s, 0, 0x4f800000, 0
    TOI trunc.s, 0, 0xcf800000, 0
    TOI utrunc.s, 0, 0xbf800000, 0
    TOI utrunc.s, 0, 0xbf000000, 0
    TOI trunc.s, 2, 0x40300000, 0
    MODE 0

    CMP 0x3f800000, 0x40000000                  # 12
    CMP 0x40000000, 0x40000000
    CMP 0x7fc00000, 0x3f800000
    CMP 0x40000000, 0x3f800000
    CMP 0x00000000, 0x80000000

    CMOV moveqz.s, a3, 0                        # 13
    CMOV movnez.s, a3, 0
    CMOV movltz.s, a3, -1
    CMOV movgez.s, a3, -1
    movi a2, 1
    wsr a2, br
    CMOV movt.s, b0, 0
    CMOV movf.s, b0, 0

    CLEAR                                       # 14
    LOADF f1, 0x7f812345
    SAVE f1
    mov.s f2, f1
    SAVE f2
    LOADF f1, 0xff812345
    abs.s f2, f1
    SAVE f2
    LOADF f1, 0x7f812345
    neg.s f2, f1
    SAVE f2

    LOADF f1, 0x3f800000                        # 15
    LOADF f2, 0x40000000
    movi a6, BUF
    movi a7, 4
    ssi f1, a6, 0
    lsi f3, a6, 0
    SAVE f3
    ssip f2, a6, 8
    addi a6, a6, -8
    lsip f3, a6, 8
    SAVE f3
    movi a8, BUF
    sub a3, a6, a8
    SAVEA a3
    ssx f1, a6, a7
    lsx f3, a6, a7
    SAVE f3
    ssxp f2, a6, a7
    addi a6, a6, -4
    lsxp f3, a6, a7
    SAVE f3
    sub a3, a6, a8
    SAVEA a3

    movi a2, 0                                  # 16
    wsr a2, cpenable
    rsync
    .global cp_second
cp_second:
    rur a3, fsr
    HARNESS_END

# Coprocessor0Disabled: count, log EPC1, enable the FPU, re-execute.
.Luser:
    wsr a2, excsave1
    wsr a3, misc0
    rsr a2, exccause
    bnei a2, 32, .Lbad
    movi a3, CP_LOG
    l32i a2, a3, 0
    addi a2, a2, 1
    s32i a2, a3, 0
    addx4 a2, a2, a3
    rsr a3, epc1
    s32i a3, a2, 0
    movi a2, 1
    wsr a2, cpenable
    rsync
    rsr a2, excsave1
    rsr a3, misc0
    rfe
.Lbad:
    movi a2, 0xBAD
    break 1, 15
