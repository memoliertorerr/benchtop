# memory.S — loads and stores of each width over the input words (count at IN, then words w).
# Per word, in order (17 words), with BUF = 0x80030000:
#   sw w → BUF: lb +0..+3, lbu +0..+3, lh +0, +2, lhu +0, +2, lw +0 (13);
#   BUF+4 cleared, sb w → BUF+5: lw BUF+4; BUF+8 cleared, sh w → BUF+10: lw BUF+8;
#   lw −4 from BUF+4 (a negative offset: w again); c.lw/c.sw through s0 = BUF: c.sw w → +12,
#   c.lw +12.
    .include "harness.inc"
    .equ BUF, 0x80030000
    HARNESS_START
    li s0, IN
    lw s1, 0(s0)
    addi s0, s0, 4
    li s2, BUF
word:
    beqz s1, done
    lw a0, 0(s0)
    addi s0, s0, 4
    sw a0, 0(s2)
    lb t0, 0(s2)
    OUTPUT t0
    lb t0, 1(s2)
    OUTPUT t0
    lb t0, 2(s2)
    OUTPUT t0
    lb t0, 3(s2)
    OUTPUT t0
    lbu t0, 0(s2)
    OUTPUT t0
    lbu t0, 1(s2)
    OUTPUT t0
    lbu t0, 2(s2)
    OUTPUT t0
    lbu t0, 3(s2)
    OUTPUT t0
    lh t0, 0(s2)
    OUTPUT t0
    lh t0, 2(s2)
    OUTPUT t0
    lhu t0, 0(s2)
    OUTPUT t0
    lhu t0, 2(s2)
    OUTPUT t0
    lw t0, 0(s2)
    OUTPUT t0
    sw zero, 4(s2)
    sb a0, 5(s2)
    lw t0, 4(s2)
    OUTPUT t0
    sw zero, 8(s2)
    sh a0, 10(s2)
    lw t0, 8(s2)
    OUTPUT t0
    addi t1, s2, 4
    lw t0, -4(t1)
    OUTPUT t0
    mv a1, s2
    .option push
    .option rvc
    c.sw a0, 12(a1)
    c.lw a2, 12(a1)
    .option pop
    OUTPUT a2
    addi s1, s1, -1
    j word
done:
    EXIT 0
