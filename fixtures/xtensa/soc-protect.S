# soc-protect.S — runs on BT31's Esp32Soc (not the bare machine): instruction-bus width rules
# and region protection. The user-vector handler logs EXCCAUSE, EXCVADDR and EPC1 and resumes
# after the faulting 3-byte load (no-transform blocks keep them 3 bytes).
#
#  1. l8ui from IRAM 0x40080000 (TRM §3.3.1: the instruction bus takes aligned words only) →
#     LoadStoreError: 3, 0x40080000, iram_byte_load.
#  2. l32i from IRAM 0x40080000 works (a word): its value (this program's first word) → a6.
#  3. wdtlb 0xF for region 0 (what IDF's mpu_ll_set_region_illegal does), then l32i from
#     0x00000000 → LoadProhibited: 28, 0, prohibited_load.
# Event log: 3, 0x40080000, iram_byte_load, 28, 0, prohibited_load.

    .include "harness.inc"
    .include "vectors.inc"

    VECTORS user=.Luser
    EVENTS_START
    movi a2, 0x20                  # UM = 1, EXCM = 0
    wsr a2, ps
    rsync
    movi a5, 0x40080000
    .begin no-transform
    .global iram_byte_load
iram_byte_load:
    l8ui a4, a5, 0
    l32i a6, a5, 0
    .end no-transform
    movi a2, 0xf
    movi a3, 0
    wdtlb a2, a3
    dsync
    .begin no-transform
    .global prohibited_load
prohibited_load:
    l32i a4, a3, 0
    .end no-transform
    HARNESS_END

.Luser:
    wsr a2, excsave1
    wsr a3, misc0
    rsr a2, exccause
    EVENT_REG a2
    rsr a2, excvaddr
    EVENT_REG a2
    rsr a2, epc1
    EVENT_REG a2
    addi a2, a2, 3
    wsr a2, epc1
    rsr a2, excsave1
    rsr a3, misc0
    rfe
