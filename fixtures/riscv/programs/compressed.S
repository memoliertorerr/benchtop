# compressed.S — the RVC and Zcb instructions (explicit c.* mnemonics so the assembler keeps
# them), one OUTPUT per result; the expected values, hand-derived, are listed
# in exec-programs.test.ts in the same order.
    .include "harness.inc"
    .equ BUF, 0x80030000
    HARNESS_START
    .option push
    .option rvc
    c.li a0, 5
    OUTPUT a0
    c.li a1, -32
    OUTPUT a1
    c.addi a0, 31
    OUTPUT a0
    c.addi a0, -32
    OUTPUT a0
    c.lui a2, 0x1f
    OUTPUT a2
    c.lui a2, 0xfffe0
    OUTPUT a2
    c.mv a3, a0
    OUTPUT a3
    c.add a3, a1
    OUTPUT a3
    c.sub a3, a0
    OUTPUT a3
    c.xor a3, a0
    OUTPUT a3
    c.or a3, a0
    OUTPUT a3
    c.and a3, a0
    OUTPUT a3
    c.srli a1, 4
    OUTPUT a1
    c.andi a1, 15
    OUTPUT a1
    c.slli a0, 3
    OUTPUT a0
    c.srai a2, 8
    OUTPUT a2
    mv t1, sp
    c.addi16sp sp, -64
    sub t0, sp, t1
    OUTPUT t0
    c.addi4spn a4, sp, 8
    sub t0, a4, sp
    OUTPUT t0
    c.swsp a0, 4(sp)
    c.lwsp a5, 4(sp)
    OUTPUT a5
    c.sw a0, 0(a4)
    c.lw s1, 0(a4)
    OUTPUT s1
    c.addi16sp sp, 64
    c.nop
    li a0, 0x12345680
    mv a1, a0
    c.zext.b a1
    OUTPUT a1
    mv a1, a0
    c.sext.b a1
    OUTPUT a1
    li a0, 0x1234f678
    mv a1, a0
    c.zext.h a1
    OUTPUT a1
    mv a1, a0
    c.sext.h a1
    OUTPUT a1
    mv a1, a0
    c.not a1
    OUTPUT a1
    li a1, 7
    li a2, -3
    c.mul a1, a2
    OUTPUT a1
    li a3, BUF
    li a2, 0xaabbccdd
    sw a2, 0(a3)
    c.lbu a2, 1(a3)
    OUTPUT a2
    c.lbu a2, 3(a3)
    OUTPUT a2
    c.lh a2, 2(a3)
    OUTPUT a2
    c.lhu a2, 2(a3)
    OUTPUT a2
    c.lh a2, 0(a3)
    OUTPUT a2
    c.lhu a2, 0(a3)
    OUTPUT a2
    li a4, 0x5a
    c.sb a4, 3(a3)
    lw t0, 0(a3)
    OUTPUT t0
    li a4, 0x1234
    c.sh a4, 0(a3)
    lw t0, 0(a3)
    OUTPUT t0
    c.sb a4, 2(a3)
    lw t0, 0(a3)
    OUTPUT t0
    .option pop
    EXIT 0
