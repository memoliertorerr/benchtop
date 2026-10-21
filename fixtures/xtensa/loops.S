# loops.S — zero-overhead loops. Each case counts body executions in a3 and stores it (RESULT);
# the long-running cases also store LCOUNT. Call0 code, PS.UM = 1, a15 = RESULTS.
#
#   LOOP 5 → 5; LOOP 1 → 1;
#   LOOPNEZ 0 → 0 (skipped); LOOPNEZ 1 → 1; LOOPNEZ 5 → 5;
#   LOOPGTZ 0 → 0; LOOPGTZ −3 → 0; LOOPGTZ 1 → 1; LOOPGTZ 5 → 5;
#   LOOP 0 runs 2^32 times: the body branches out on its 1000th pass (a taken branch at LEND − 3
#     doesn't loop back), after 999 loop-backs: count 1000, LCOUNT 0xFFFFFFFF − 999 = 0xFFFFFC18;
#   LOOPNEZ −3 (0xFFFFFFFD passes): out on the 100th: count 100, LCOUNT 0xFFFFFFFC − 99 =
#     0xFFFFFF99;
#   LOOP 200 with timer 0 (CCOMPARE0 = CCOUNT + 50) firing inside the body: the level-1 handler
#     logs 0x11 and EPC1 (inside timer_body…timer_end) and the loop still runs 200 times.
#
#   LOOP 5 left on its 2nd pass by `beq a3, a4, LEND` (a taken branch to LEND): count 2,
#     LCOUNT 3;
# Results: 5, 1, 0, 1, 5, 0, 0, 1, 5, 1000, 0xFFFFFC18, 100, 0xFFFFFF99, 2, 3, 200.
# Event log (a14-based here — RESULTS owns a15): 0x11, EPC1.

    .include "harness.inc"
    .include "vectors.inc"

    .set SAVE_L1, SCRATCH + 0x40

    .macro COUNT op, n
    movi a2, \n
    movi a3, 0
    \op a2, 1f
    addi a3, a3, 1
1:  RESULT a3
    .endm

    VECTORS user=.Ll1
    RESULTS_START
    movi a14, SCRATCH              # the handler's event log: [SCRATCH] = next free slot
    movi a2, EVENTS
    s32i a2, a14, 0
    movi a2, 0x20                  # UM = 1
    wsr a2, ps
    rsync

    COUNT loop, 5
    COUNT loop, 1
    COUNT loopnez, 0
    COUNT loopnez, 1
    COUNT loopnez, 5
    COUNT loopgtz, 0
    COUNT loopgtz, -3
    COUNT loopgtz, 1
    COUNT loopgtz, 5

    # LOOP 0: 2^32 passes; leave on the 1000th.
    movi a2, 0
    movi a3, 0
    movi a4, 1000
    loop a2, 1f
    addi a3, a3, 1
    beq a3, a4, 2f
1:  nop
2:  RESULT a3
    rsr a5, lcount
    RESULT a5

    # LOOPNEZ −3: 0xFFFFFFFD passes; leave on the 100th.
    movi a2, -3
    movi a3, 0
    movi a4, 100
    loopnez a2, 1f
    addi a3, a3, 1
    beq a3, a4, 2f
1:  nop
2:  RESULT a3
    rsr a5, lcount
    RESULT a5

    # LOOP 5 left by a taken branch whose target is LEND itself (`beqz a8, LEND` is how
    # compiled loops exit early, e.g. newlib's strcpy): the second pass branches to LEND and the
    # loop ends — no loop-back after a taken branch, even to LEND. Count 2, LCOUNT 5 − 1 − 1 = 3.
    movi a2, 5
    movi a3, 0
    movi a4, 2
    loop a2, 1f
    addi a3, a3, 1
    beq a3, a4, 1f
1:  RESULT a3
    rsr a5, lcount
    RESULT a5

    # LOOP 200 with a timer interrupt in the body.
    movi a2, 1 << 6
    wsr a2, intenable
    rsr a2, ccount
    addi a2, a2, 50
    wsr a2, ccompare0
    movi a2, 200
    movi a3, 0
    loop a2, 1f
    .global timer_body
timer_body:
    addi a3, a3, 1
    nop
    nop
    .global timer_end
timer_end:
1:  RESULT a3
    HARNESS_END

# Level 1: timer 0. Logs 0x11 and EPC1 through a14 (not the a15 macros), acknowledges, RFE.
.Ll1:
    movi a13, SAVE_L1
    s32i a2, a13, 0
    s32i a3, a13, 4
    rsr a2, exccause
    bnei a2, 4, .Lbad
    l32i a3, a14, 0
    movi a2, 0x11
    s32i a2, a3, 0
    rsr a2, epc1
    s32i a2, a3, 4
    addi a3, a3, 8
    s32i a3, a14, 0
    movi a2, 0
    wsr a2, ccompare0
    l32i a3, a13, 4
    l32i a2, a13, 0
    rfe

.Lbad:
    movi a2, 0xBAD
    break 1, 15
