# alu.S — RV32I and M register and immediate ops over the input pairs (count at IN, then pairs
# a, b). Per pair, in order (33 words): add sub sll slt sltu xor srl sra or and · mul mulh mulhsu
# mulhu div divu rem remu · addi 2047, addi −2048, slti 5, sltiu −1, sltiu 1, xori −1,
# ori 0x7ff, andi −16, slli 1, slli 31, srli 1, srli 31, srai 1, srai 31, lui+addi 0x12345678.
# The test computes the references with BigInt.
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
    add t0, a0, a1
    OUTPUT t0
    sub t0, a0, a1
    OUTPUT t0
    sll t0, a0, a1
    OUTPUT t0
    slt t0, a0, a1
    OUTPUT t0
    sltu t0, a0, a1
    OUTPUT t0
    xor t0, a0, a1
    OUTPUT t0
    srl t0, a0, a1
    OUTPUT t0
    sra t0, a0, a1
    OUTPUT t0
    or t0, a0, a1
    OUTPUT t0
    and t0, a0, a1
    OUTPUT t0
    mul t0, a0, a1
    OUTPUT t0
    mulh t0, a0, a1
    OUTPUT t0
    mulhsu t0, a0, a1
    OUTPUT t0
    mulhu t0, a0, a1
    OUTPUT t0
    div t0, a0, a1
    OUTPUT t0
    divu t0, a0, a1
    OUTPUT t0
    rem t0, a0, a1
    OUTPUT t0
    remu t0, a0, a1
    OUTPUT t0
    addi t0, a0, 2047
    OUTPUT t0
    addi t0, a0, -2048
    OUTPUT t0
    slti t0, a0, 5
    OUTPUT t0
    sltiu t0, a0, -1
    OUTPUT t0
    sltiu t0, a0, 1
    OUTPUT t0
    xori t0, a0, -1
    OUTPUT t0
    ori t0, a0, 0x7ff
    OUTPUT t0
    andi t0, a0, -16
    OUTPUT t0
    slli t0, a0, 1
    OUTPUT t0
    slli t0, a0, 31
    OUTPUT t0
    srli t0, a0, 1
    OUTPUT t0
    srli t0, a0, 31
    OUTPUT t0
    srai t0, a0, 1
    OUTPUT t0
    srai t0, a0, 31
    OUTPUT t0
    li t0, 0x12345678
    OUTPUT t0
    addi s1, s1, -1
    j pair
done:
    EXIT 0
