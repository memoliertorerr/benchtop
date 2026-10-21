# shifts.S — SAR and the shifts, on a2 = 0x12345678, a5 = 0x80000000. Results, in order:
#   ssl 4 → SAR 28; sll: 0x23456780 · ssl 0 → SAR 32; sll: 0x12345678 (shift by 0) ·
#   ssr 8; srl: 0x00123456 · sra a5: 0xff800000 ·
#   ssai 12; src a2:a5: (a5 >> 12) | (a2 << 20) = 0x00080000 | 0x67800000 = 0x67880000 ·
#   ssa8l 1 → SAR 8; src: (a5 >> 8) | (a2 << 24) = 0x00800000 | 0x78000000 = 0x78800000 ·
#   ssa8b 1 → SAR 24; src: (a5 >> 24) | (a2 << 8) = 0x80 | 0x34567800 = 0x34567880 ·
#   ssr 3; sra a2: 0x02468acf · slli 1: 0x2468acf0 · slli 3 by 31: 0x80000000 ·
#   srli 15: 0x00002468 · srai a5 31: 0xffffffff · srai a5 4: 0xf8000000 ·
#   ssai 0; src: a5 itself 0x80000000 · ssr 0; srl: a2 itself 0x12345678 · ssai 17; rsr.sar: 17
    .include "harness.inc"
    HARNESS_START
    RESULTS_START
    movi a2, 0x12345678
    movi a5, 0x80000000
    movi a3, 4
    ssl a3
    sll a4, a2
    RESULT a4
    movi a3, 0
    ssl a3
    sll a4, a2
    RESULT a4
    movi a3, 8
    ssr a3
    srl a4, a2
    RESULT a4
    sra a4, a5
    RESULT a4
    ssai 12
    src a4, a2, a5
    RESULT a4
    movi a3, 1
    ssa8l a3
    src a4, a2, a5
    RESULT a4
    ssa8b a3
    src a4, a2, a5
    RESULT a4
    movi a3, 3
    ssr a3
    sra a4, a2
    RESULT a4
    slli a4, a2, 1
    RESULT a4
    movi a6, 3
    slli a4, a6, 31
    RESULT a4
    srli a4, a2, 15
    RESULT a4
    srai a4, a5, 31
    RESULT a4
    srai a4, a5, 4
    RESULT a4
    ssai 0
    src a4, a2, a5
    RESULT a4
    movi a3, 0
    ssr a3
    srl a4, a2
    RESULT a4
    ssai 17
    rsr a4, sar
    RESULT a4
    HARNESS_END
