# link: libgcc
# fpu-libgcc.S — runs the toolchain libgcc's FPU-step routines: __divsf3 (div0.s, nexp01.s,
# const.s, maddn.s, mkdadj.s, addexp.s, addexpm.s, divn.s), __ieee754_sqrtf (sqrt0.s, mksadj.s,
# …), __recipsf2 (recip0.s, msub.s) and __rsqrtsf2 (rsqrt0.s, mul.s).
#
# The test writes CALL_ARGS (SCRATCH + 0x800): words 0–1 = the float arguments' bits, word 2 =
# FCR, word 4 = which routine (0 __divsf3, 1 __ieee754_sqrtf, 2 __recipsf2, 3 __rsqrtsf2).
# The program enables the FPU (CPENABLE bit 0), sets FCR and clears FSR, calls the routine and
# stores its result in word 5 and FSR in word 6, then `break 1, 15`.

    .include "harness.inc"

    .set CALL_ARGS, SCRATCH + 0x800

    HARNESS_START
    movi a2, 0x40020               # WOE = 1, UM = 1
    wsr a2, ps
    movi a2, 1
    wsr a2, cpenable
    rsync
    movi a4, CALL_ARGS
    l32i a2, a4, 8
    wur a2, fcr
    movi a2, 0
    wur a2, fsr
    l32i a10, a4, 0
    l32i a11, a4, 4
    l32i a5, a4, 16
    beqi a5, 1, 1f
    beqi a5, 2, 2f
    beqi a5, 3, 3f
    call8 __divsf3
    j 9f
1:  call8 __ieee754_sqrtf
    j 9f
2:  call8 __recipsf2
    j 9f
3:  call8 __rsqrtsf2
9:  s32i a10, a4, 20
    rur a2, fsr
    s32i a2, a4, 24
    HARNESS_END
