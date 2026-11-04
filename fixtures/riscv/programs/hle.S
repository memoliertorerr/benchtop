# hle.S — high-level emulation on the RISC-V core (BT106). The test replaces sum9, twice, outer,
# many and scratchy with TypeScript handlers (their own bodies would return -1) and points the
# resume address at hle_resume (zeros nothing executes). Outputs, in order:
#   sum9(1…8, 9 on the stack) = 45 + 1000 (a plain handler: a0–a7 and the stack argument);
#   twice(21) = double(21) + double(22) = 86 (a generator calling the firmware twice); s0 kept;
#   outer(5) = nest_helper(5) + 1, nest_helper calling twice: 123 (two generators waiting);
#   rec(50): 50 nested calls, then twice(1), plus one per level = 56; sp back at its start;
#   many() = sum10(1…10) = 55 (a call out with 2 arguments on the stack);
#   scratchy() = load_word(its scratch, where it wrote 0x77) = 0x77.
    .include "harness.inc"
    HARNESS_START
    li s0, 0x5a5a
    mv s1, sp
    li a0, 1
    li a1, 2
    li a2, 3
    li a3, 4
    li a4, 5
    li a5, 6
    li a6, 7
    li a7, 8
    addi sp, sp, -16
    li t0, 9
    sw t0, 0(sp)
    call sum9
    addi sp, sp, 16
    OUTPUT a0
    li a0, 21
    call twice
    OUTPUT a0
    OUTPUT s0
    li a0, 5
    call outer
    OUTPUT a0
    li a0, 50
    call rec
    OUTPUT a0
    sub t0, sp, s1
    OUTPUT t0
    call many
    OUTPUT a0
    call scratchy
    OUTPUT a0
    EXIT 0

# Replaced: these bodies never run.
sum9:
    li a0, -1
    ret
twice:
    li a0, -1
    ret
outer:
    li a0, -1
    ret
many:
    li a0, -1
    ret
scratchy:
    li a0, -1
    ret

# The firmware the handlers call.
double:
    slli a0, a0, 1
    ret

nest_helper:
    addi sp, sp, -16
    sw ra, 12(sp)
    call twice
    addi a0, a0, 100
    lw ra, 12(sp)
    addi sp, sp, 16
    ret

rec:
    addi sp, sp, -16
    sw ra, 12(sp)
    sw s0, 8(sp)
    mv s0, a0
    beqz a0, 1f
    addi a0, a0, -1
    call rec
    addi a0, a0, 1
    j 2f
1:
    li a0, 1
    call twice
2:
    lw s0, 8(sp)
    lw ra, 12(sp)
    addi sp, sp, 16
    ret

sum10:
    add a0, a0, a1
    add a0, a0, a2
    add a0, a0, a3
    add a0, a0, a4
    add a0, a0, a5
    add a0, a0, a6
    add a0, a0, a7
    lw t0, 0(sp)
    add a0, a0, t0
    lw t0, 4(sp)
    add a0, a0, t0
    ret

load_word:
    lw a0, 0(a0)
    ret

    .balign 16
hle_resume:
    .word 0
    .word 0
