# atomics.S — the A extension over the input pairs (count at IN, then pairs a, b). Per pair, in
# order (22 words), with the word M at 0x80030000 holding a before each AMO: for amoswap amoadd
# amoxor amoand amoor amomin amomax amominu amomaxu (.w, with aq/rl variants): the old value
# returned, then M after (18); then lr.w M (a) and sc.w b: the sc result (0) and M (b); then
# sc.w a without a reservation: the result (1) and M (still b).
    .include "harness.inc"
    .equ M, 0x80030000
    .macro AMO op
    sw a0, 0(s2)
    \op t0, a1, (s2)
    OUTPUT t0
    lw t0, 0(s2)
    OUTPUT t0
    .endm
    HARNESS_START
    li s0, IN
    lw s1, 0(s0)
    addi s0, s0, 4
    li s2, M
pair:
    beqz s1, done
    lw a0, 0(s0)
    lw a1, 4(s0)
    addi s0, s0, 8
    AMO amoswap.w
    AMO amoadd.w.aq
    AMO amoxor.w.rl
    AMO amoand.w.aqrl
    AMO amoor.w
    AMO amomin.w
    AMO amomax.w
    AMO amominu.w
    AMO amomaxu.w
    sw a0, 0(s2)
    lr.w t0, (s2)
    sc.w t1, a1, (s2)
    OUTPUT t1
    lw t0, 0(s2)
    OUTPUT t0
    sc.w t1, a0, (s2)
    OUTPUT t1
    lw t0, 0(s2)
    OUTPUT t0
    addi s1, s1, -1
    j pair
done:
    EXIT 0
