# loadstore.S — loads and stores on a2 = SCRATCH, which starts zeroed. Store 0x80ff7f01 at
# [0]: bytes 01 7f ff 80. Results, in order:
#   l8ui [0] 0x01 · l8ui [2] 0xff · l8ui [3] 0x80 · l16ui [0] 0x7f01 · l16ui [2] 0x80ff ·
#   l16si [2] 0xffff80ff (sign) · l16si [0] 0x7f01 · l32i [0] 0x80ff7f01 ·
#   s8i 0xab at [5], s16i 0xcdef at [6]; l32i [4] = bytes 00 ab ef cd: 0xcdefab00 ·
#   unaligned l32i at [1] = bytes 7f ff 80 00: 0x0080ff7f · unaligned l16ui at [1]: 0xff7f ·
#   unaligned s32i 0x11223344 at [5] (bytes 5–8: 44 33 22 11); l32i [4] = 00 44 33 22:
#   0x22334400 · l32i [8] = 11 00 00 00: 0x00000011 ·
#   s16i 0x12345 stores its low half 0x2345 at [12]; l32i [12]: 0x00002345 ·
#   s8i 0x1ff stores 0xff at [16]; l8ui [16]: 0xff; l16si at [15] (a2 + 1 + 14) = bytes 00 ff:
#   0xffffff00
    .include "harness.inc"
    HARNESS_START
    RESULTS_START
    movi a2, SCRATCH
    movi a3, 0x80ff7f01
    s32i a3, a2, 0
    l8ui a4, a2, 0
    RESULT a4
    l8ui a4, a2, 2
    RESULT a4
    l8ui a4, a2, 3
    RESULT a4
    l16ui a4, a2, 0
    RESULT a4
    l16ui a4, a2, 2
    RESULT a4
    l16si a4, a2, 2
    RESULT a4
    l16si a4, a2, 0
    RESULT a4
    l32i a4, a2, 0
    RESULT a4
    movi a5, 0xab
    s8i a5, a2, 5
    movi a5, 0xcdef
    s16i a5, a2, 6
    l32i a4, a2, 4
    RESULT a4
    addi a6, a2, 1
    l32i a4, a6, 0
    RESULT a4
    l16ui a4, a6, 0
    RESULT a4
    movi a7, 0x11223344
    s32i a7, a6, 4
    l32i a4, a2, 4
    RESULT a4
    l32i a4, a2, 8
    RESULT a4
    movi a8, 0x12345
    s16i a8, a2, 12
    l32i a4, a2, 12
    RESULT a4
    movi a8, 0x1ff
    s8i a8, a2, 16
    l8ui a4, a2, 16
    RESULT a4
    l16si a4, a6, 14
    RESULT a4
    HARNESS_END
