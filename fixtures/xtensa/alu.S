# alu.S — ALU ops on a2 = 7, a3 = 5. Results (hand-derived), in order:
#   add 12 · sub 2 · sub(5−7) 0xfffffffe · addx2 (7<<1)+5 = 19 · addx4 33 · addx8 61 ·
#   subx2 (7<<1)−5 = 9 · subx4 23 · subx8 51 · and 0xf0f0&0x0ff0 = 0x00f0 · or 0xfff0 ·
#   xor 0xff00 · neg 7 = 0xfffffff9 · abs(−7) 7 · abs(0x80000000) 0x80000000 ·
#   min(7,−3) 0xfffffffd · max 7 · minu(7,0xfffffffd) 7 · maxu 0xfffffffd ·
#   sext(0x1ff,7) 0xffffffff · sext(0x17f,7) 0x7f · sext(0x12345,15) 0x2345 ·
#   clamps(1000,7) 127 · clamps(−1000,7) 0xffffff80 · clamps(100,7) 100 ·
#   nsau(1) 31 · nsau(0) 32 · nsa(1) 30 · nsa(−2) 30 · nsa(0) 31 ·
#   moveqz (t=0: moves) 222 · movnez (t=0: keeps) 111 · movltz (t=−5: moves) 222 ·
#   movgez (t=−5: keeps) 111
    .include "harness.inc"
    HARNESS_START
    RESULTS_START
    movi a2, 7
    movi a3, 5
    .begin no-transform
    add a4, a2, a3
    .end no-transform
    RESULT a4
    sub a4, a2, a3
    RESULT a4
    sub a4, a3, a2
    RESULT a4
    addx2 a4, a2, a3
    RESULT a4
    addx4 a4, a2, a3
    RESULT a4
    addx8 a4, a2, a3
    RESULT a4
    subx2 a4, a2, a3
    RESULT a4
    subx4 a4, a2, a3
    RESULT a4
    subx8 a4, a2, a3
    RESULT a4
    movi a5, 0xf0f0
    movi a6, 0x0ff0
    and a4, a5, a6
    RESULT a4
    or a4, a5, a6
    RESULT a4
    xor a4, a5, a6
    RESULT a4
    neg a4, a2
    RESULT a4
    abs a4, a4
    RESULT a4
    movi a7, 0x80000000
    abs a4, a7
    RESULT a4
    movi a8, -3
    min a4, a2, a8
    RESULT a4
    max a4, a2, a8
    RESULT a4
    minu a4, a2, a8
    RESULT a4
    maxu a4, a2, a8
    RESULT a4
    movi a9, 0x1ff
    sext a4, a9, 7
    RESULT a4
    movi a9, 0x17f
    sext a4, a9, 7
    RESULT a4
    movi a9, 0x12345
    sext a4, a9, 15
    RESULT a4
    movi a9, 1000
    clamps a4, a9, 7
    RESULT a4
    movi a9, -1000
    clamps a4, a9, 7
    RESULT a4
    movi a9, 100
    clamps a4, a9, 7
    RESULT a4
    movi a9, 1
    nsau a4, a9
    RESULT a4
    movi a9, 0
    nsau a4, a9
    RESULT a4
    movi a9, 1
    nsa a4, a9
    RESULT a4
    movi a9, -2
    nsa a4, a9
    RESULT a4
    movi a9, 0
    nsa a4, a9
    RESULT a4
    movi a10, 222
    movi a11, 0
    movi a4, 111
    moveqz a4, a10, a11
    RESULT a4
    movi a4, 111
    movnez a4, a10, a11
    RESULT a4
    movi a11, -5
    movi a4, 111
    movltz a4, a10, a11
    RESULT a4
    movi a4, 111
    movgez a4, a10, a11
    RESULT a4
    HARNESS_END
