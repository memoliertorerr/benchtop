# bitmanip.S — Zba, Zbb, Zbs, Zbkb and Xh3bextm over the input pairs (count at IN, then pairs
# a, b). Per pair, in order (41 words): sh1add sh2add sh3add · andn orn xnor clz ctz cpop max
# maxu min minu sext.b sext.h zext.h rol ror rori 7 rori 0 orc.b rev8 · bclr bclri 13 bext
# bexti 31 binv binvi 0 bset bseti 31 · pack packh brev8 zip unzip · h3.bextm a,b size 1,
# size 8, size 5 · h3.bextmi shamt 3 size 8, shamt 31 size 4, shamt 0 size 1. The test
# computes the references with BigInt.
    .include "harness.inc"
    HARNESS_START
    li s0, IN
    lw s1, 0(s0)
    addi s0, s0, 4
pair:
    beqz s1, done
    lw a0, 0(s0)
    lw a1, 4(s0)
    addi s0, s0, 8
    sh1add t0, a0, a1
    OUTPUT t0
    sh2add t0, a0, a1
    OUTPUT t0
    sh3add t0, a0, a1
    OUTPUT t0
    andn t0, a0, a1
    OUTPUT t0
    orn t0, a0, a1
    OUTPUT t0
    xnor t0, a0, a1
    OUTPUT t0
    clz t0, a0
    OUTPUT t0
    ctz t0, a0
    OUTPUT t0
    cpop t0, a0
    OUTPUT t0
    max t0, a0, a1
    OUTPUT t0
    maxu t0, a0, a1
    OUTPUT t0
    min t0, a0, a1
    OUTPUT t0
    minu t0, a0, a1
    OUTPUT t0
    sext.b t0, a0
    OUTPUT t0
    sext.h t0, a0
    OUTPUT t0
    zext.h t0, a0
    OUTPUT t0
    rol t0, a0, a1
    OUTPUT t0
    ror t0, a0, a1
    OUTPUT t0
    rori t0, a0, 7
    OUTPUT t0
    rori t0, a0, 0
    OUTPUT t0
    orc.b t0, a0
    OUTPUT t0
    rev8 t0, a0
    OUTPUT t0
    bclr t0, a0, a1
    OUTPUT t0
    bclri t0, a0, 13
    OUTPUT t0
    bext t0, a0, a1
    OUTPUT t0
    bexti t0, a0, 31
    OUTPUT t0
    binv t0, a0, a1
    OUTPUT t0
    binvi t0, a0, 0
    OUTPUT t0
    bset t0, a0, a1
    OUTPUT t0
    bseti t0, a0, 31
    OUTPUT t0
    pack t0, a0, a1
    OUTPUT t0
    packh t0, a0, a1
    OUTPUT t0
    brev8 t0, a0
    OUTPUT t0
    zip t0, a0
    OUTPUT t0
    unzip t0, a0
    OUTPUT t0
    h3_bextm t0, a0, a1, 1
    OUTPUT t0
    h3_bextm t0, a0, a1, 8
    OUTPUT t0
    h3_bextm t0, a0, a1, 5
    OUTPUT t0
    h3_bextmi t0, a0, 3, 8
    OUTPUT t0
    h3_bextmi t0, a0, 31, 4
    OUTPUT t0
    h3_bextmi t0, a0, 0, 1
    OUTPUT t0
    addi s1, s1, -1
    j pair
done:
    EXIT 0
