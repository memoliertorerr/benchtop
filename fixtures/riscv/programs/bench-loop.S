# bench-loop.S — the simulated-MIPS loop (BT64): a bitwise CRC-32 (reflected, 0xEDB88320) of a
# 4 KB buffer (byte i = 7i mod 256), as many rounds as the word at IN says: loads, ALU ops,
# taken and untaken branches, mostly compressed. Outputs the last round's CRC.
    .include "harness.inc"
    .equ BUF, 0x80030000
    HARNESS_START
    li a0, BUF
    li a1, 4096
    li a2, 0
fill:
    sb a2, 0(a0)
    addi a2, a2, 7
    addi a0, a0, 1
    addi a1, a1, -1
    bnez a1, fill
    li t0, IN
    lw s1, 0(t0)
    li a4, 0xedb88320
round:
    li a0, BUF
    li a1, 4096
    li a3, -1
byte:
    lbu t0, 0(a0)
    xor a3, a3, t0
    li t1, 8
bit:
    andi t2, a3, 1
    srli a3, a3, 1
    beqz t2, 1f
    xor a3, a3, a4
1:  addi t1, t1, -1
    bnez t1, bit
    addi a0, a0, 1
    addi a1, a1, -1
    bnez a1, byte
    not a3, a3
    addi s1, s1, -1
    bnez s1, round
    OUTPUT a3
    EXIT 0
