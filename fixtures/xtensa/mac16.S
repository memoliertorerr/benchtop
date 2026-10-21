# mac16.S — the MAC16 option: 40-bit accumulator (ACCLO, ACCHI read sign-extended), M0–M3,
# every operand form and half selection, LDINC/LDDEC, MULA.*.LDINC/LDDEC. Each check stores
# ACCLO then ACCHI (RESULT pairs) unless noted. Hand-derived (sums checked with Python ints):
#
#  a2 = 0x0003fffe (hi 3, lo −2), a3 = 0x00050007 (hi 5, lo 7)
#   mul.aa.ll a2, a3 → −14: fffffff2, ffffffff     mul.aa.hl → 3·7 = 21: 15, 0
#   mul.aa.lh → −2·5 = −10: fffffff6, ffffffff     mul.aa.hh → 15: f, 0
#   umul.aa.ll → 0xfffe·7 = 0x6fff2: 6fff2, 0     umul.aa.hh → 15: f, 0
#  300 × mula.aa.ll 0x7fff·0x7fff from 0 → 0x4afed4012c: fed4012c, 4a
#  then 700 × muls.aa.ll → −429470515600: 018ffe70, ffffff9c
#  ACC = 0x7f_ffffffff (WSR), mula.aa.ll 1·1 → wraps to −2^39: 0, ffffff80
#  m0 = 0x00020003, m1 = 0xfff9000b (hi −7, lo 11), m2 = 0x00040005, m3 = 0x8000ffff (hi
#  −32768, lo −1):
#   mul.ad.ll a2, m2 → −2·5 = −10: fffffff6, ffffffff    mul.ad.hh a3, m3 → 5·−32768 =
#   −163840: fffd8000, ffffffff     mul.da.lh m0, a3 → 3·5 = 15: f, 0    mul.da.hl m1, a2 →
#   −7·−2 = 14: e, 0     mul.dd.hh m1, m2 → −7·4 = −28: ffffffe4, ffffffff
#   mul.dd.lh m0, m3 → 3·−32768 = −98304: fffe8000, ffffffff
#  BUF = SCRATCH + 0x200 holds 0x11111111, 0x22222222, 0x33333333, 0x44444444
#   ldinc m0, a4 (a4 = BUF − 4) → m0 = 0x11111111, a4 = BUF (stored: m0, a4 − BUF = 0)
#   lddec m1, a5 (a5 = BUF + 8) → m1 = 0x22222222, a5 = BUF + 4 (stored: m1, 4)
#   ACC = 0; m2 = 0x00040005; mula.dd.ll.ldinc m0, a4, m0, m2: ACC += 0x1111·5 = 0x5555 with
#   the old m0, then m0 ← [BUF + 4] = 0x22222222, a4 = BUF + 4 (stored: ACCLO 5555, m0, 4)
#   mula.da.hh.lddec m3, a5, m1, a3: ACC += 0x2222·5 = 0xaaaa → 0xffff, m3 ← [BUF] =
#   0x11111111, a5 = BUF (stored: ACCLO ffff, m3, 0)

    .include "harness.inc"

    .set BUF, SCRATCH + 0x200

    .macro ACC
    rsr a8, acclo
    RESULT a8
    rsr a8, acchi
    RESULT a8
    .endm

    .macro CLEARACC
    movi a8, 0
    wsr a8, acclo
    wsr a8, acchi
    .endm

    HARNESS_START
    RESULTS_START
    movi a2, 0x20                  # UM = 1, EXCM = 0: zero-overhead loops only run with EXCM clear
    wsr a2, ps
    rsync
    movi a2, 0x0003fffe
    movi a3, 0x00050007
    mul.aa.ll a2, a3
    ACC
    mul.aa.hl a2, a3
    ACC
    mul.aa.lh a2, a3
    ACC
    mul.aa.hh a2, a3
    ACC
    umul.aa.ll a2, a3
    ACC
    umul.aa.hh a2, a3
    ACC

    CLEARACC
    movi a6, 0x7fff
    movi a7, 300
    loop a7, 1f
    mula.aa.ll a6, a6
1:  ACC
    movi a7, 700
    loop a7, 1f
    muls.aa.ll a6, a6
1:  ACC

    movi a8, 0xffffffff
    wsr a8, acclo
    movi a8, 0x7f
    wsr a8, acchi
    movi a6, 1
    mula.aa.ll a6, a6
    ACC

    movi a8, 0x00020003
    wsr a8, m0
    movi a8, 0xfff9000b
    wsr a8, m1
    movi a8, 0x00040005
    wsr a8, m2
    movi a8, 0x8000ffff
    wsr a8, m3
    mul.ad.ll a2, m2
    ACC
    mul.ad.hh a3, m3
    ACC
    mul.da.lh m0, a3
    ACC
    mul.da.hl m1, a2
    ACC
    mul.dd.hh m1, m2
    ACC
    mul.dd.lh m0, m3
    ACC

    movi a4, BUF
    movi a8, 0x11111111
    s32i a8, a4, 0
    movi a8, 0x22222222
    s32i a8, a4, 4
    movi a8, 0x33333333
    s32i a8, a4, 8
    movi a8, 0x44444444
    s32i a8, a4, 12
    movi a9, BUF
    addi a4, a9, -4
    ldinc m0, a4
    rsr a8, m0
    RESULT a8
    sub a8, a4, a9
    RESULT a8
    addi a5, a9, 8
    lddec m1, a5
    rsr a8, m1
    RESULT a8
    sub a8, a5, a9
    RESULT a8

    CLEARACC
    movi a8, 0x00040005
    wsr a8, m2
    mula.dd.ll.ldinc m0, a4, m0, m2
    rsr a8, acclo
    RESULT a8
    rsr a8, m0
    RESULT a8
    sub a8, a4, a9
    RESULT a8
    mula.da.hh.lddec m3, a5, m1, a3
    rsr a8, acclo
    RESULT a8
    rsr a8, m3
    RESULT a8
    sub a8, a5, a9
    RESULT a8
    HARNESS_END
