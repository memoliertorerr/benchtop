# ccompare-int.S — timer, software and NMI interrupts at levels 1, 3, 5 and 7. Call0 code
# (PS.WOE = 0) with PS.UM = 1, so level 1 goes through the user vector. Every handler appends to
# the event log (harness.inc) and saves what it clobbers in its own save area.
#
#  1. INTENABLE = bit 6, CCOMPARE0 = CCOUNT + 1000, WAITI 0. The core sleeps until CCOUNT reaches
#     CCOMPARE0 and takes interrupt 6 (level 1): `j` at the vector and one store run first, so
#     the handler reads CCOUNT = base + 1002 (T0_DELTA). It logs 0x11, acknowledges by writing
#     CCOMPARE0 = 0 (2^32 cycles away), arms CCOMPARE1 = CCOUNT + 40 with INTENABLE bit 15, drops
#     to PS.INTLEVEL 1 with EXCM = 0 and spins at l1_spin. Interrupt 15 (level 3) preempts it:
#     the level-3 handler logs 0x33 and EPC3 (inside l1_spin…l1_spin_end) and EPS3 (= 0x21: the
#     level-1 handler's PS), writes CCOMPARE1 = 0 and RFI 3 returns into the spin. The level-1
#     handler logs 0x1E, restores EXCM and EPC1, and RFE returns after the WAITI; main logs 0x01.
#     A further 2000-cycle spin shows timer 0 doesn't fire again (T0_COUNT = 1).
#  2. With PS.INTLEVEL 15: INTSET bits 7 and 29 → INTERRUPT = 0x20000080; INTCLEAR bit 29 →
#     0x00000080; INTSET 29 again. Both stay pending (masked).
#  3. `break 1, 14` is a checkpoint: the test pulses interrupt 14 (NMI) there. The NMI is taken
#     despite INTLEVEL 15: the handler logs 0x77 and EPS7 (0x2F), RFI 7; main logs 0x02.
#  4. PS = UM | EXCM, INTLEVEL 0: EXCM masks levels ≤ 3, so 7 and 29 stay pending, but timer 2
#     (CCOMPARE2 = CCOUNT + 30, interrupt 16, level 5) comes in during a spin: the level-5 handler
#     logs 0x55 and EPS5 (0x30), writes CCOMPARE2 = 0, RFI 5. Main logs 0x03.
#  5. PS = UM: interrupt 29 (level 3) is taken first — logs 0x3D, INTCLEAR 29, RFI 3 — then 7
#     (level 1, EXCCAUSE 4) — logs 0x17, INTCLEAR 7, RFE. Main logs 0x04.
#
# Event log: 0x11, 0x33, EPC3, 0x21, 0x1E, 0x01, 0x77, 0x2F, 0x02, 0x55, 0x30, 0x03, 0x3D, 0x17,
# 0x04. Results: T0_DELTA 1002, T0_COUNT 1, INT_SET 0x20000080, INT_CLEAR 0x80, and the final
# INTERRUPT 0.

    .include "harness.inc"
    .include "vectors.inc"

    .set T0_BASE, 0x10             # offsets from SCRATCH (a15)
    .set T0_DELTA, 0x14
    .set T0_COUNT, 0x18
    .set INT_SET, 0x1C
    .set INT_CLEAR, 0x20
    .set INT_END, 0x24
    .set SAVE_L1, 0x40
    .set SAVE_L3, 0x50
    .set SAVE_L5, 0x60
    .set SAVE_NMI, 0x70

    VECTORS user=.Ll1, level3=.Ll3, level5=.Ll5, nmi=.Lnmi
    EVENTS_START
    movi a2, 0
    s32i a2, a15, T0_COUNT
    movi a2, 0x20                  # UM = 1, INTLEVEL 0, EXCM 0, WOE 0
    wsr a2, ps
    rsync

    # 1. Timer 0 wakes WAITI; timer 1 preempts the level-1 handler.
    movi a2, 1 << 6
    wsr a2, intenable
    movi a5, 1000
    rsr a3, ccount
    add a4, a3, a5
    wsr a4, ccompare0
    s32i a3, a15, T0_BASE
    waiti 0
    EVENT 0x01
    movi a2, 1000
1:  addi a2, a2, -1
    bnez a2, 1b

    # 2. Software interrupts 7 and 29, masked by INTLEVEL 15.
    rsil a2, 15
    movi a2, (1 << 7) | (1 << 29)
    rsr a3, intenable
    or a3, a3, a2
    wsr a3, intenable
    wsr a2, intset
    rsr a3, interrupt
    s32i a3, a15, INT_SET
    movi a4, 1 << 29
    wsr a4, intclear
    rsr a3, interrupt
    s32i a3, a15, INT_CLEAR
    wsr a4, intset

    # 3. The NMI at INTLEVEL 15 (the test pulses interrupt 14 at this checkpoint).
    break 1, 14
    EVENT 0x02

    # 4. EXCM masks levels ≤ 3; timer 2 (level 5) still comes in.
    movi a2, 0x30                  # UM | EXCM, INTLEVEL 0
    wsr a2, ps
    rsync
    movi a3, 1 << 16
    rsr a2, intenable
    or a2, a2, a3
    wsr a2, intenable
    rsr a2, ccount
    addi a2, a2, 30
    wsr a2, ccompare2
    movi a2, 100
1:  addi a2, a2, -1
    bnez a2, 1b
    EVENT 0x03

    # 5. EXCM = 0: level 3 (29) first, then level 1 (7).
    movi a2, 0x20
    wsr a2, ps
    rsync
    EVENT 0x04
    rsr a2, interrupt
    s32i a2, a15, INT_END
    HARNESS_END

# Level 1 (user vector): timer 0 or software interrupt 7.
.Ll1:
    s32i a2, a15, SAVE_L1
    rsr a2, ccount
    s32i a3, a15, SAVE_L1 + 4
    s32i a4, a15, SAVE_L1 + 8
    rsr a3, exccause
    bnei a3, 4, .Lbad
    rsr a3, interrupt
    rsr a4, intenable
    and a3, a3, a4
    bbsi a3, 6, .Ll1_timer
    bbsi a3, 7, .Ll1_soft
    j .Lbad
.Ll1_timer:
    l32i a3, a15, T0_BASE
    sub a2, a2, a3
    s32i a2, a15, T0_DELTA
    l32i a2, a15, T0_COUNT
    addi a2, a2, 1
    s32i a2, a15, T0_COUNT
    EVENT 0x11
    movi a2, 0
    wsr a2, ccompare0
    rsr a2, ccount
    addi a2, a2, 40
    wsr a2, ccompare1
    movi a3, 1 << 15
    rsr a2, intenable
    or a2, a2, a3
    wsr a2, intenable
    rsr a2, epc1
    s32i a2, a15, SAVE_L1 + 12
    movi a2, 0x21                  # UM | INTLEVEL 1, EXCM 0: levels 2+ may preempt
    wsr a2, ps
    rsync
    movi a2, 50
    .global l1_spin
l1_spin:
    addi a2, a2, -1
    bnez a2, l1_spin
    .global l1_spin_end
l1_spin_end:
    EVENT 0x1E
    movi a2, 0x30                  # UM | EXCM again for RFE
    wsr a2, ps
    rsync
    l32i a2, a15, SAVE_L1 + 12
    wsr a2, epc1
    j .Ll1_return
.Ll1_soft:
    EVENT 0x17
    movi a2, 1 << 7
    wsr a2, intclear
.Ll1_return:
    l32i a4, a15, SAVE_L1 + 8
    l32i a3, a15, SAVE_L1 + 4
    l32i a2, a15, SAVE_L1
    rfe

# Level 3: timer 1 or software interrupt 29.
.Ll3:
    s32i a2, a15, SAVE_L3
    s32i a3, a15, SAVE_L3 + 4
    s32i a4, a15, SAVE_L3 + 8
    rsr a3, interrupt
    rsr a4, intenable
    and a3, a3, a4
    bbsi a3, 15, .Ll3_timer
    bbsi a3, 29, .Ll3_soft
    j .Lbad
.Ll3_timer:
    EVENT 0x33
    rsr a4, epc3
    EVENT_REG a4
    rsr a4, eps3
    EVENT_REG a4
    movi a2, 0
    wsr a2, ccompare1
    j .Ll3_return
.Ll3_soft:
    EVENT 0x3D
    movi a2, 1 << 29
    wsr a2, intclear
.Ll3_return:
    l32i a4, a15, SAVE_L3 + 8
    l32i a3, a15, SAVE_L3 + 4
    l32i a2, a15, SAVE_L3
    rfi 3

# Level 5: timer 2.
.Ll5:
    s32i a2, a15, SAVE_L5
    s32i a3, a15, SAVE_L5 + 4
    s32i a4, a15, SAVE_L5 + 8
    EVENT 0x55
    rsr a4, eps5
    EVENT_REG a4
    movi a2, 0
    wsr a2, ccompare2
    l32i a4, a15, SAVE_L5 + 8
    l32i a3, a15, SAVE_L5 + 4
    l32i a2, a15, SAVE_L5
    rfi 5

# Level 7: the NMI.
.Lnmi:
    s32i a2, a15, SAVE_NMI
    s32i a3, a15, SAVE_NMI + 4
    s32i a4, a15, SAVE_NMI + 8
    EVENT 0x77
    rsr a4, eps7
    EVENT_REG a4
    l32i a4, a15, SAVE_NMI + 8
    l32i a3, a15, SAVE_NMI + 4
    l32i a2, a15, SAVE_NMI
    rfi 7

.Lbad:
    movi a2, 0xBAD
    break 1, 15
