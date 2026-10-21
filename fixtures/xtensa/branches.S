# branches.S — every branch form, taken and not taken. Each check sets a2 to its number, then
# branches; a wrong outcome jumps to .Lfail, which halts with that a2. All passing: a2 = 0 and
# a14 = the number of checks (56).
    .include "harness.inc"

    # TAKEN n, branch…: the branch must jump to its target (1f).
    .macro TAKEN n, insn:vararg
    movi a2, \n
    \insn 1f
    j .Lfail
1:  addi a14, a14, 1
    .endm

    # NOTTAKEN n, branch…: the branch must fall through.
    .macro NOTTAKEN n, insn:vararg
    movi a2, \n
    \insn 1f
    j 2f
1:  j .Lfail
2:  addi a14, a14, 1
    .endm

    HARNESS_START
    movi a14, 0
    movi a3, 5
    movi a4, 5
    movi a5, -1
    movi a6, 0x80000000
    movi a7, 31
    movi a8, 0
    movi a9, 6
    movi a10, 0x0f
    movi a11, 0x10
    TAKEN 1, beq a3, a4,
    NOTTAKEN 2, beq a3, a9,
    TAKEN 3, bne a3, a9,
    NOTTAKEN 4, bne a3, a4,
    TAKEN 5, blt a5, a3,
    NOTTAKEN 6, blt a3, a5,
    TAKEN 7, bge a3, a5,
    NOTTAKEN 8, bge a5, a3,
    TAKEN 9, bltu a3, a5,
    NOTTAKEN 10, bltu a5, a3,
    TAKEN 11, bgeu a5, a3,
    NOTTAKEN 12, bgeu a3, a5,
    TAKEN 13, bany a3, a10,
    NOTTAKEN 14, bany a3, a11,
    TAKEN 15, bnone a3, a11,
    NOTTAKEN 16, bnone a3, a10,
    TAKEN 17, ball a10, a3,
    NOTTAKEN 18, ball a3, a10,
    TAKEN 19, bnall a3, a10,
    NOTTAKEN 20, bnall a10, a3,
    TAKEN 21, bbs a6, a7,
    NOTTAKEN 22, bbc a6, a7,
    TAKEN 23, bbc a3, a7,
    NOTTAKEN 24, bbs a3, a7,
    TAKEN 25, bbsi a6, 31,
    NOTTAKEN 26, bbci a6, 31,
    TAKEN 27, bbci a3, 31,
    NOTTAKEN 28, bbsi a3, 31,
    TAKEN 29, beqi a5, -1,
    NOTTAKEN 30, beqi a3, -1,
    TAKEN 31, bnei a3, 4,
    NOTTAKEN 32, bnei a3, 5,
    TAKEN 33, blti a3, 6,
    NOTTAKEN 34, blti a3, 5,
    TAKEN 35, bgei a3, 5,
    NOTTAKEN 36, bgei a3, 6,
    TAKEN 37, beqi a3, 5,
    TAKEN 38, bltui a3, 32768,
    NOTTAKEN 39, bltui a5, 65536,
    TAKEN 40, bgeui a5, 65536,
    NOTTAKEN 41, bgeui a3, 6,
    TAKEN 42, bltui a3, 256,
    TAKEN 43, beqz a8,
    NOTTAKEN 44, beqz a3,
    TAKEN 45, bnez a3,
    NOTTAKEN 46, bnez a8,
    TAKEN 47, bltz a5,
    NOTTAKEN 48, bltz a3,
    TAKEN 49, bgez a8,
    NOTTAKEN 50, bgez a5,
    TAKEN 51, beqz.n a8,
    NOTTAKEN 52, beqz.n a3,
    TAKEN 53, bnez.n a3,
    NOTTAKEN 54, bnez.n a8,
    movi a12, 256
    TAKEN 55, beqi a12, 256,
    NOTTAKEN 56, bgei a3, 128,
    movi a2, 0
    HARNESS_END
.Lfail:
    HARNESS_END
