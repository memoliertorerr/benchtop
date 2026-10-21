# exceptions.S — XEA2 general exceptions on call0 code (PS.WOE = 0). Handlers log to the event
# log (harness.inc) and return past the faulting instruction (EPC1/DEPC + 3: the faulting
# instructions sit in no-transform blocks so none is narrowed to 2 bytes).
#
#  1. PS.UM = 1: `ill` at ill_user → user vector (+0x340): logs 0xA0, EXCCAUSE 0, EPC1 = ill_user.
#  2. PS.UM = 0: `ill` at ill_kernel → kernel vector (+0x300): logs 0xB0, EXCCAUSE 0,
#     EPC1 = ill_kernel.
#  3. PS.UM = 1: `syscall` at do_syscall → user vector: logs 0xA1, EXCCAUSE 1, EPC1 = do_syscall.
#  4. A load from 0x10000000 (unmapped on the bare machine) at bad_load → user vector: logs 0xA3,
#     EXCCAUSE 3 (LoadStoreError), EXCVADDR 0x10000000. Still in the handler (PS.EXCM = 1) it
#     runs `ill` at handler_ill → double vector (+0x3C0): logs 0xD0, DEPC = handler_ill,
#     EXCCAUSE 0, EPC1 = bad_load (kept), PS.EXCM = 1 (0x30); RFDE returns into the handler
#     with EXCM still 1; the handler logs 0xA4 and PS (0x30) and RFE returns after bad_load.
#  5. Main logs 0xEE and PS (0x20: RFE cleared EXCM, UM untouched).
#
# Event log: 0xA0, 0, ill_user, 0xB0, 0, ill_kernel, 0xA1, 1, do_syscall, 0xA3, 3, 0x10000000,
# 0xD0, handler_ill, 0, bad_load, 0x30, 0xA4, 0x30, 0xEE, 0x20.

    .include "harness.inc"
    .include "vectors.inc"

    .set SAVE_USER, 0x40               # offsets from SCRATCH (a15)
    .set SAVE_KERNEL, 0x50
    .set SAVE_DOUBLE, 0x60

    VECTORS user=.Luser, kernel=.Lkernel, double=.Ldouble
    EVENTS_START
    movi a2, 0x20                  # UM = 1
    wsr a2, ps
    rsync
    .begin no-transform
    .global ill_user
ill_user:
    ill
    .end no-transform

    movi a2, 0                     # kernel mode: UM = 0
    wsr a2, ps
    rsync
    .begin no-transform
    .global ill_kernel
ill_kernel:
    ill
    .end no-transform

    movi a2, 0x20
    wsr a2, ps
    rsync
    .begin no-transform
    .global do_syscall
do_syscall:
    syscall
    .end no-transform

    movi a4, 0x10000000
    .begin no-transform
    .global bad_load
bad_load:
    l32i a5, a4, 0
    .end no-transform

    EVENT 0xEE
    rsr a4, ps
    EVENT_REG a4
    HARNESS_END

# User vector: log the cause and EPC1, step past the instruction, RFE.
.Luser:
    s32i a2, a15, SAVE_USER
    s32i a3, a15, SAVE_USER + 4
    s32i a4, a15, SAVE_USER + 8
    rsr a4, exccause
    beqi a4, 0, .Luser_ill
    beqi a4, 1, .Luser_syscall
    beqi a4, 3, .Luser_bus
    j .Lbad
.Luser_ill:
    EVENT 0xA0
    j .Luser_log
.Luser_syscall:
    EVENT 0xA1
.Luser_log:
    rsr a4, exccause
    EVENT_REG a4
    rsr a4, epc1
    EVENT_REG a4
    j .Luser_return
.Luser_bus:
    EVENT 0xA3
    rsr a4, exccause
    EVENT_REG a4
    rsr a4, excvaddr
    EVENT_REG a4
    .begin no-transform
    .global handler_ill
handler_ill:
    ill                            # PS.EXCM = 1: a double exception
    .end no-transform
    EVENT 0xA4
    rsr a4, ps
    EVENT_REG a4
.Luser_return:
    rsr a4, epc1
    addi a4, a4, 3
    wsr a4, epc1
    l32i a4, a15, SAVE_USER + 8
    l32i a3, a15, SAVE_USER + 4
    l32i a2, a15, SAVE_USER
    rfe

.Lkernel:
    s32i a2, a15, SAVE_KERNEL
    s32i a3, a15, SAVE_KERNEL + 4
    s32i a4, a15, SAVE_KERNEL + 8
    EVENT 0xB0
    rsr a4, exccause
    EVENT_REG a4
    rsr a4, epc1
    EVENT_REG a4
    addi a4, a4, 3
    wsr a4, epc1
    l32i a4, a15, SAVE_KERNEL + 8
    l32i a3, a15, SAVE_KERNEL + 4
    l32i a2, a15, SAVE_KERNEL
    rfe

.Ldouble:
    s32i a2, a15, SAVE_DOUBLE
    s32i a3, a15, SAVE_DOUBLE + 4
    s32i a4, a15, SAVE_DOUBLE + 8
    EVENT 0xD0
    rsr a4, depc
    EVENT_REG a4
    rsr a4, exccause
    EVENT_REG a4
    rsr a4, epc1
    EVENT_REG a4
    rsr a4, ps
    EVENT_REG a4
    rsr a4, depc
    addi a4, a4, 3
    wsr a4, depc
    l32i a4, a15, SAVE_DOUBLE + 8
    l32i a3, a15, SAVE_DOUBLE + 4
    l32i a2, a15, SAVE_DOUBLE
    rfde

.Lbad:
    movi a2, 0xBAD
    break 1, 15
