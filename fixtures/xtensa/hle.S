# hle.S — BT97: functions TypeScript replaces (packages/esp32/src/hle/hle.test.ts). The test writes
# a selector at SCRATCH before the run and replaces `target`, `twice`, `seven`, `outer`, `inner` and
# `deep`; their own bodies, if they ever ran, store 0xDEAD at SCRATCH + 4.
#   1 call4 target(7, 5) → a2      2 call8 target(7, 5) → a2      3 call12 target(7, 5) → a2
#     (a3 = 0x33 must survive each call; with call8 a7 = 0x77 too)
#   4 call8 twice(3) → a2 (calls add3)              5 call4 twice(3) → a2
#   6 call8 seven() → a2 (calls sum7 with seven arguments, the seventh on the stack)
#   7 call8 outer(1) → a2: outer calls mid, mid calls inner, inner calls add3 — two TypeScript
#     frames waiting at once
#   8 drec(12) = 12 + … + 1 + deep(5) through call8, deep calling rec(5): window overflows and
#     underflows around the TypeScript frame; a3 = WINDOWBASE, a4 = WINDOWSTART, a5 = overflows,
#     a6 = underflows (vectors.inc counts them)
    .include "harness.inc"
    .include "vectors.inc"
    VECTORS
    # PS: WOE = 1, UM = 1, EXCM = 0, INTLEVEL = 0.
    movi a2, 0x40020
    wsr a2, ps
    rsync
    movi a3, SCRATCH
    l32i a3, a3, 0
    beqi a3, 1, t_call4
    beqi a3, 2, t_call8
    beqi a3, 3, t_call12
    beqi a3, 4, t_twice8
    beqi a3, 5, t_twice4
    beqi a3, 6, t_seven
    beqi a3, 7, t_nested
    beqi a3, 8, t_deep
    movi a2, 0xbad
    HARNESS_END

t_call4:
    movi a3, 0x33
    movi a6, 7
    movi a7, 5
    call4 target
    mov a2, a6
    HARNESS_END

t_call8:
    movi a3, 0x33
    movi a7, 0x77
    movi a10, 7
    movi a11, 5
    call8 target
    mov a2, a10
    HARNESS_END

t_call12:
    movi a3, 0x33
    movi a14, 7
    movi a15, 5
    call12 target
    mov a2, a14
    HARNESS_END

t_twice8:
    movi a10, 3
    call8 twice
    mov a2, a10
    HARNESS_END

t_twice4:
    movi a6, 3
    call4 twice
    mov a2, a6
    HARNESS_END

t_seven:
    call8 seven
    mov a2, a10
    HARNESS_END

t_nested:
    movi a10, 1
    call8 outer
    mov a2, a10
    HARNESS_END

t_deep:
    movi a10, 12
    call8 drec
    mov a2, a10
    rsr a3, windowbase
    rsr a4, windowstart
    rsr a5, misc0
    rsr a6, misc1
    HARNESS_END

# The replaced functions: what runs instead is TypeScript.
    .align 4
    .global target
target:
    entry a1, 32
    movi a2, SCRATCH
    movi a3, 0xdead
    s32i a3, a2, 4
    mov a2, a3
    retw

    .align 4
    .global twice
twice:
    entry a1, 32
    movi a2, SCRATCH
    movi a3, 0xdead
    s32i a3, a2, 4
    retw

    .align 4
    .global seven
seven:
    entry a1, 32
    movi a2, SCRATCH
    movi a3, 0xdead
    s32i a3, a2, 4
    retw

    .align 4
    .global outer
outer:
    entry a1, 32
    movi a2, SCRATCH
    movi a3, 0xdead
    s32i a3, a2, 4
    retw

    .align 4
    .global inner
inner:
    entry a1, 32
    movi a2, SCRATCH
    movi a3, 0xdead
    s32i a3, a2, 4
    retw

    .align 4
    .global deep
deep:
    entry a1, 32
    movi a2, SCRATCH
    movi a3, 0xdead
    s32i a3, a2, 4
    retw

# Firmware the TypeScript calls.
    # add3(a, b, c) = a + b + c
    .align 4
    .global add3
add3:
    entry a1, 32
    add a2, a2, a3
    add a2, a2, a4
    retw

    # sum7(a … g) = their sum; g is on the stack above the frame (the caller's a1)
    .align 4
    .global sum7
sum7:
    entry a1, 32
    add a2, a2, a3
    add a2, a2, a4
    add a2, a2, a5
    add a2, a2, a6
    add a2, a2, a7
    l32i a8, a1, 32
    add a2, a2, a8
    retw

    # mid(y) = inner(y) + 100
    .align 4
    .global mid
mid:
    entry a1, 32
    mov a10, a2
    call8 inner
    addi a2, a10, 100
    retw

    # drec(n) = n == 0 ? deep(5) : n + drec(n − 1)
    .align 4
    .global drec
drec:
    entry a1, 32
    bnez a2, 1f
    movi a10, 5
    call8 deep
    mov a2, a10
    retw
1:  addi a10, a2, -1
    call8 drec
    add a2, a2, a10
    retw

    # rec(n) = n == 1 ? 1 : n + rec(n − 1)
    .align 4
    .global rec
rec:
    entry a1, 32
    beqi a2, 1, 1f
    addi a10, a2, -1
    call8 rec
    add a2, a2, a10
1:  retw
