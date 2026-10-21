# muldiv.S — MUL16S/U, MULL, MULUH/MULSH, QUOS/QUOU/REMS/REMU. Results with RESULT, in order
# (hand-derived; the 32 × 32 products checked with Python integers):
#
#   mul16s 0x00018000 · 0xffff0002 (−32768 · 2)        → 0xffff0000
#   mul16u same operands (32768 · 2)                    → 0x00010000
#   mul16s 0x7fff · 0x7fff                              → 0x3fff0001
#   mull 0x12345678 · 0x9abcdef0                        → 0x242d2080
#   muluh 0x12345678 · 0x9abcdef0                       → 0x0b00ea4e
#   muluh 0xffffffff · 0xffffffff                       → 0xfffffffe
#   muluh 0x80000000 · 2                                → 0x00000001
#   mulsh −1 · −1                                       → 0
#   mulsh 0x80000000 · 0x80000000 (2^62)                → 0x40000000
#   mulsh −2 · 3                                        → 0xffffffff
#   mulsh 0x12345678 · −0x09abcdef                      → 0xff4ff15b
#   quos −7 / 2 → −3; rems −7 % 2 → −1; quos 7 / −2 → −3; rems 7 % −2 → 1
#   quou 0xfffffff9 / 2 → 0x7ffffffc; remu 0xfffffff9 % 2 → 1
#   quos 0x80000000 / −1 → 0x80000000; rems 0x80000000 % −1 → 0
#   quou 100 / 0x80000000 → 0; remu 100 % 0x80000000 → 100
# Then quos at div_zero_s and remu at div_zero_u with a zero divisor raise
# IntegerDivideByZero (EXCCAUSE 6) with EPC1 at the instruction; the handler logs cause and
# EPC1 at DZ_LOG and resumes after it (EPC1 + 3), leaving the destination (a6 = 0x55) as it was.

    .include "harness.inc"
    .include "vectors.inc"

    .set DZ_LOG, SCRATCH + 0x100

    .macro OP3 op, a, b
    movi a2, \a
    movi a3, \b
    \op a4, a2, a3
    RESULT a4
    .endm

    VECTORS user=.Luser
    RESULTS_START
    movi a2, DZ_LOG
    movi a3, DZ_LOG + 4
    s32i a3, a2, 0
    movi a2, 0x20                  # UM = 1
    wsr a2, ps
    rsync

    OP3 mul16s, 0x00018000, 0xffff0002
    OP3 mul16u, 0x00018000, 0xffff0002
    OP3 mul16s, 0x7fff, 0x7fff
    OP3 mull, 0x12345678, 0x9abcdef0
    OP3 muluh, 0x12345678, 0x9abcdef0
    OP3 muluh, 0xffffffff, 0xffffffff
    OP3 muluh, 0x80000000, 2
    OP3 mulsh, -1, -1
    OP3 mulsh, 0x80000000, 0x80000000
    OP3 mulsh, -2, 3
    OP3 mulsh, 0x12345678, -0x09abcdef
    OP3 quos, -7, 2
    OP3 rems, -7, 2
    OP3 quos, 7, -2
    OP3 rems, 7, -2
    OP3 quou, 0xfffffff9, 2
    OP3 remu, 0xfffffff9, 2
    OP3 quos, 0x80000000, -1
    OP3 rems, 0x80000000, -1
    OP3 quou, 100, 0x80000000
    OP3 remu, 100, 0x80000000

    movi a2, 9
    movi a3, 0
    movi a6, 0x55
    .begin no-transform
    .global div_zero_s
div_zero_s:
    quos a6, a2, a3
    .global div_zero_u
div_zero_u:
    remu a6, a2, a3
    .end no-transform
    RESULT a6
    HARNESS_END

# IntegerDivideByZero: log EXCCAUSE and EPC1, resume after the instruction.
.Luser:
    wsr a2, excsave1
    wsr a3, misc0
    wsr a4, misc1
    movi a3, DZ_LOG
    l32i a2, a3, 0
    rsr a4, exccause
    s32i a4, a2, 0
    rsr a4, epc1
    s32i a4, a2, 4
    addi a2, a2, 8
    s32i a2, a3, 0
    addi a4, a4, 3
    wsr a4, epc1
    rsr a2, excsave1
    rsr a3, misc0
    rsr a4, misc1
    rfe
