# branches.S — conditional branches over the input pairs (count at IN, then pairs a, b). Per
# pair, in order (8 words): beq bne blt bge bltu bgeu taken (1) or not (0), then c.beqz a and
# c.bnez a. After the pairs, the jumps (6 words): jal's link − its own return label (0), jalr's
# link − its return label (0), the jalr target with bit 0 set (reached: 1), c.jal's link −
# return label (0), c.jr reached (1), c.jalr's link − return label (0).
    .include "harness.inc"
    .macro TAKEN br, ra, rb
    li t0, 1
    \br \ra, \rb, 1f
    li t0, 0
1:  OUTPUT t0
    .endm
    HARNESS_START
    li s0, IN
    lw s1, 0(s0)
    addi s0, s0, 4
pair:
    beqz s1, jumps
    lw a0, 0(s0)
    lw a1, 4(s0)
    addi s0, s0, 8
    TAKEN beq, a0, a1
    TAKEN bne, a0, a1
    TAKEN blt, a0, a1
    TAKEN bge, a0, a1
    TAKEN bltu, a0, a1
    TAKEN bgeu, a0, a1
    .option push
    .option rvc
    li t0, 1
    c.beqz a0, 1f
    li t0, 0
1:  OUTPUT t0
    li t0, 1
    c.bnez a0, 1f
    li t0, 0
1:  OUTPUT t0
    .option pop
    addi s1, s1, -1
    j pair
jumps:
    .option push
    .option norvc
    jal ra, jal_target
jal_return:
    la t1, jal_return
    sub t0, ra, t1
    OUTPUT t0
    la t1, jalr_target + 1
    jalr ra, 0(t1)
jalr_return:
    la t1, jalr_return
    sub t0, ra, t1
    OUTPUT t0
    OUTPUT s3
    .option rvc
    c.jal cjal_target
cjal_return:
    la t1, cjal_return
    sub t0, ra, t1
    OUTPUT t0
    la a5, cjr_target
    c.jr a5
cjr_back:
    OUTPUT s3
    la a5, cjalr_target
    c.jalr a5
cjalr_return:
    la t1, cjalr_return
    sub t0, ra, t1
    OUTPUT t0
    .option pop
    EXIT 0
jal_target:
    ret
jalr_target:
    li s3, 1
    ret
cjal_target:
    ret
cjr_target:
    li s3, 1
    j cjr_back
cjalr_target:
    ret
