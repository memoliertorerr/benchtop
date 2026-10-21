# zcmp.S — Zcmp's push/pop/popret/popretz (native) and register moves (harness macros). Outputs, in
# order (the test lists the expected values):
#   cm.push {ra,s0-s11},-64: sp change, then the 16 words at the new sp (3 untouched, ra, s0–s11);
#   cm.pop of the same list after clobbering: sp change, ra, s0–s11;
#   cm.push {ra,s0},-48 (spimm 2): sp change, the words at sp+44 (s0) and sp+40 (ra);
#   cm.pop {ra,s0},48: s0, ra, sp change;
#   a call to a cm.popret function: a0, s0, s1; to a cm.popretz one: a0; sp − STACK_TOP;
#   cm.mvsa01 s2,s3: s2, s3; cm.mva01s s4,s5: a0, a1; cm.mva01s s1,s0: a0, a1.
    .include "harness.inc"
    HARNESS_START
    li s0, 0x100
    li s1, 0x101
    li s2, 0x102
    li s3, 0x103
    li s4, 0x104
    li s5, 0x105
    li s6, 0x106
    li s7, 0x107
    li s8, 0x108
    li s9, 0x109
    li s10, 0x10a
    li s11, 0x10b
    li ra, 0x1ff
    mv a7, sp
    cm.push {ra, s0-s11}, -64
    sub t0, sp, a7
    OUTPUT t0
    mv a6, sp
    li a5, 16
1:  lw t0, 0(a6)
    OUTPUT t0
    addi a6, a6, 4
    addi a5, a5, -1
    bnez a5, 1b
    li s0, 0
    li s1, 0
    li s2, 0
    li s3, 0
    li s4, 0
    li s5, 0
    li s6, 0
    li s7, 0
    li s8, 0
    li s9, 0
    li s10, 0
    li s11, 0
    li ra, 0
    cm.pop {ra, s0-s11}, 64
    sub t0, sp, a7
    OUTPUT t0
    OUTPUT ra
    OUTPUT s0
    OUTPUT s1
    OUTPUT s2
    OUTPUT s3
    OUTPUT s4
    OUTPUT s5
    OUTPUT s6
    OUTPUT s7
    OUTPUT s8
    OUTPUT s9
    OUTPUT s10
    OUTPUT s11
    li s0, 0x200
    li ra, 0x2ff
    mv a7, sp
    cm.push {ra, s0}, -48
    sub t0, sp, a7
    OUTPUT t0
    lw t0, 44(sp)
    OUTPUT t0
    lw t0, 40(sp)
    OUTPUT t0
    li s0, 0
    li ra, 0
    cm.pop {ra, s0}, 48
    OUTPUT s0
    OUTPUT ra
    sub t0, sp, a7
    OUTPUT t0
    li s0, 0x300
    li s1, 0x301
    call popret_function
    OUTPUT a0
    OUTPUT s0
    OUTPUT s1
    call popretz_function
    OUTPUT a0
    li t1, STACK_TOP
    sub t0, sp, t1
    OUTPUT t0
    li a0, 5
    li a1, 6
    cm_mvsa01 2, 3
    OUTPUT s2
    OUTPUT s3
    li s4, 7
    li s5, 8
    cm_mva01s 4, 5
    OUTPUT a0
    OUTPUT a1
    li s0, 9
    li s1, 10
    cm_mva01s 1, 0
    OUTPUT a0
    OUTPUT a1
    EXIT 0
popret_function:
    cm.push {ra, s0-s1}, -16
    li s0, 1
    li s1, 2
    li a0, 77
    cm.popret {ra, s0-s1}, 16
popretz_function:
    cm.push {ra}, -32
    li a0, 55
    cm.popretz {ra}, 32
