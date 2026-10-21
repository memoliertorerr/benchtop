# traps.S — machine and user mode (BT64): exceptions, mret, user mode, counters, the machine
# CSRs, PMP storage, the CSR hook and interrupts. Every trap appends mcause, mepc, mtval to the
# outputs (the handler skips the trapping instruction; an instruction access fault returns to
# ra; an ecall from user mode returns to machine mode); interrupt handlers append mcause, mepc.
# The t_* labels mark the instructions the test expects traps at (it reads their addresses and
# bits from traps.lst and traps.bin). Interleaved OUTPUTs are listed in exec-traps.test.ts.
    .include "harness.inc"
    .equ BUF, 0x80030000
    HARNESS_START
    la t0, handler
    csrw mtvec, t0
    .option push
    .option norvc
t_ecall:
    ecall
t_ebreak:
    ebreak
    .option rvc
t_cebreak:
    c.ebreak
    .option norvc
t_unimp:
    unimp
t_cunimp:
    .half 0
t_sret:
    sret
t_ro:
    csrw mvendorid, t0
t_nocsr:
    csrr t0, 0x7c0
    li a0, BUF
t_lmis:
    lw t0, 1(a0)
t_hmis:
    lh t0, 3(a0)
t_smis:
    sw t0, 2(a0)
t_shmis:
    sh t0, 1(a0)
    addi a1, a0, 2
t_amomis:
    amoadd.w t0, t1, (a1)
t_lrmis:
    lr.w t0, (a1)
t_lfault:
    lw t0, 0(zero)
    li a2, 4
t_sfault:
    sw t0, 0(a2)
t_amofault:
    amoswap.w t0, t1, (a2)
t_lrfault:
    lr.w t0, (a2)
    li a3, 0x100
t_ffault:
    jalr ra, 0(a3)
    .option pop

    # User mode: an ecall there comes back to machine mode.
    csrw mcounteren, zero
    la t0, user1
    csrw mepc, t0
    li t0, 0x1800
    csrc mstatus, t0
    mret
user1:
t_uecall:
    ecall
    csrr t0, mstatus
    OUTPUT t0
    # User mode with mstatus.TW: privileged CSRs, counters without mcounteren, wfi, mret trap.
    la t0, user2
    csrw mepc, t0
    li t0, 0x1800
    csrc mstatus, t0
    li t0, 0x200000
    csrs mstatus, t0
    mret
user2:
    .option push
    .option norvc
t_umstatus:
    csrr t0, mstatus
t_ucycle:
    rdcycle t0
t_uwfi:
    wfi
t_umret:
    mret
t_uecall2:
    ecall
    .option pop
    li t0, 0x200000
    csrc mstatus, t0
    # mcounteren.CY and IR let user mode read cycle and instret.
    li t0, 5
    csrw mcounteren, t0
    la t0, user3
    csrw mepc, t0
    li t0, 0x1800
    csrc mstatus, t0
    mret
user3:
    rdcycle t0
    rdinstret t0
    li t0, 0x600d
    OUTPUT t0
t_uecall3:
    ecall

    # Counters: 10 nops between two reads → 11 (the first read retires too).
    .option push
    .option norvc
    csrr s2, minstret
    .rept 10
    nop
    .endr
    csrr s3, minstret
    sub t0, s3, s2
    OUTPUT t0
    csrr s2, mcycle
    .rept 10
    nop
    .endr
    csrr s3, mcycle
    sub t0, s3, s2
    OUTPUT t0
    li t0, 100
    csrw minstret, t0
    csrr t1, minstret
    OUTPUT t1
    li t0, 1000
    csrw mcycle, t0
    csrr t1, mcycle
    OUTPUT t1
    li t0, 7
    csrw minstreth, t0
    csrr t1, minstreth
    OUTPUT t1
    csrwi mcountinhibit, 5
    csrr s2, minstret
    csrr s4, mcycle
    nop
    nop
    csrr s3, minstret
    csrr s5, mcycle
    csrwi mcountinhibit, 0
    sub t0, s3, s2
    OUTPUT t0
    sub t0, s5, s4
    OUTPUT t0
    .option pop

    # Machine CSRs.
    li t0, 0x5a5a
    csrw mscratch, t0
    csrr t1, mscratch
    OUTPUT t1
    csrr t1, misa
    OUTPUT t1
    csrr t1, mhartid
    OUTPUT t1
    li t0, 0x80000001
    csrw mepc, t0
    csrr t1, mepc
    OUTPUT t1
    li t0, 0x80000003
    csrw mtvec, t0
    csrr t1, mtvec
    OUTPUT t1
    la t0, handler
    csrw mtvec, t0
    li t0, -1
    csrw mie, t0
    csrr t1, mie
    OUTPUT t1
    csrw mie, zero
    csrr t1, mip
    OUTPUT t1
    # PMP storage: pmpaddr WARL to 30 bits; pmpcfg R=0,W=1 reserved; a locked entry ignores writes.
    li t0, -1
    csrw pmpaddr0, t0
    csrr t1, pmpaddr0
    OUTPUT t1
    li t0, 0x1f1f1f1f
    csrw pmpcfg0, t0
    csrr t1, pmpcfg0
    OUTPUT t1
    li t0, 0x02020202
    csrw pmpcfg0, t0
    csrr t1, pmpcfg0
    OUTPUT t1
    li t0, 0x81
    csrw pmpcfg0, t0
    li t0, 0x1234
    csrw pmpaddr0, t0
    csrr t1, pmpaddr0
    OUTPUT t1
    csrw pmpcfg0, zero
    csrr t1, pmpcfg0
    OUTPUT t1
    # The CSR hook's register (the test's hook implements 0xbc0).
    csrr t1, 0xbc0
    OUTPUT t1
    li t0, 0x77
    csrw 0xbc0, t0
    csrr t1, 0xbc0
    OUTPUT t1

    # Interrupts, vectored: MTI, then MEI and MSI together (MEI first), then masked.
    la t0, vectors
    ori t0, t0, 1
    csrw mtvec, t0
    li t0, 0x888
    csrw mie, t0
    csrsi mstatus, 8
    li t0, 0x80
    LINES t0
t_after_mti:
    li t0, 0x1111
    OUTPUT t0
    li t0, 0x808
    LINES t0
t_after_mei:
    li t0, 0x2222
    OUTPUT t0
    csrci mstatus, 8
    li t0, 0x80
    LINES t0
    li t0, 0x3333
    OUTPUT t0
    csrr t0, mip
    OUTPUT t0
    LINES zero
    # WFI with MIE clear: the test raises MTI while the core sleeps; WFI ends, no trap.
t_wfi:
    wfi
    li t0, 0x4444
    OUTPUT t0
    csrr t0, mip
    OUTPUT t0
    LINES zero
    # WFI with MIE set: the interrupt is taken with mepc after the WFI.
    csrsi mstatus, 8
t_wfi2:
    wfi
t_after_wfi2:
    li t0, 0x5555
    OUTPUT t0
    EXIT 0

    .align 2
handler:
    csrr t0, mcause
    OUTPUT t0
    csrr t0, mepc
    OUTPUT t0
    csrr t0, mtval
    OUTPUT t0
    csrr t0, mcause
    li t1, 1
    beq t0, t1, fetch_fault
    li t1, 8
    beq t0, t1, from_user
    csrr t0, mepc
    lhu t1, 0(t0)
    andi t1, t1, 3
    li t2, 3
    addi t0, t0, 2
    bne t1, t2, 1f
    addi t0, t0, 2
1:  csrw mepc, t0
    mret
fetch_fault:
    csrw mepc, ra
    mret
from_user:
    csrr t0, mepc
    addi t0, t0, 4
    csrw mepc, t0
    li t0, 0x1800
    csrs mstatus, t0
    mret

    # Vectored mode: exceptions at the base, interrupt n at base + 4n.
    .align 6
    .option push
    .option norvc
vectors:
    j handler
    .rept 2
    j handler
    .endr
    j irq_msi
    .rept 3
    j handler
    .endr
    j irq_mti
    .rept 3
    j handler
    .endr
    j irq_mei
    .option pop
    .macro IRQ_HANDLER bit
    csrr t0, mcause
    OUTPUT t0
    csrr t0, mepc
    OUTPUT t0
    csrr t0, mip
    li t1, ~(1 << \bit)
    and t0, t0, t1
    LINES t0
    mret
    .endm
irq_msi:
    IRQ_HANDLER 3
irq_mti:
    IRQ_HANDLER 7
irq_mei:
    IRQ_HANDLER 11
