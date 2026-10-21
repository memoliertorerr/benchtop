# movi.S — immediate extremes, exact encodings (no-transform: no literal substitution):
#   a2 = movi −2048 = 0xfffff800 · a3 = movi 2047 · a4 = addmi 2047 + (−32768) = 0xffff87ff ·
#   a5 = addmi 2047 + 32512 = 0x86ff · a6 = addi 2047 − 128 = 1919 · a7 = addi 2047 + 127 = 2174 ·
#   a8 = addmi 0 + 256 = 256 · a9 = movi 0 · a10 = addi −1 + (−1) = 0xfffffffe
    .include "harness.inc"
    HARNESS_START
    .begin no-transform
    movi a2, -2048
    movi a3, 2047
    addmi a4, a3, -32768
    addmi a5, a3, 32512
    addi a6, a3, -128
    addi a7, a3, 127
    movi a8, 0
    addmi a8, a8, 256
    movi a9, 0
    movi a10, -1
    addi a10, a10, -1
    .end no-transform
    HARNESS_END
