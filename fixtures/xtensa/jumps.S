# jumps.S — J, JX, CALL0, CALLX0, RET (call0 ABI). a5 counts the paths taken:
#   j over a "movi a5, 99" → +1 · jx over another → +2 · call0 sub1 → +10 ·
#   callx0 sub2 → +100 · call0 nested (saves a0 in a8, calls sub1, restores) → +1000 +10.
# Expected a5 = 1123; a2 = 1 (sub1's marker); a3 = 2 (sub2's marker).
    .include "harness.inc"
    HARNESS_START
    movi a5, 0
    movi a2, 0
    movi a3, 0
    j .L1
    movi a5, 99
.L1:
    addi a5, a5, 1
    movi a6, .L2
    jx a6
    movi a5, 99
.L2:
    addi a5, a5, 2
    call0 sub1
    movi a7, sub2
    callx0 a7
    call0 nested
    HARNESS_END

    .align 4
sub1:
    addi a5, a5, 10
    movi a2, 1
    ret

    .align 4
sub2:
    addi a5, a5, 100
    movi a3, 2
    ret

    .align 4
nested:
    mov a8, a0
    addi a5, a5, 1000
    call0 sub1
    mov a0, a8
    ret
