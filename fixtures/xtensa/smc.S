# smc.S — code that changes after it has run (BT37's predecode cache must see every change).
# Run on an Esp32Soc by packages/esp32/src/soc/predecode.test.ts, which sets up flash and the
# MMU first. Call0 ABI; each RESULT is a function's return value (a2), old code then new:
#   1. IRAM: `patch` (movi a2, 1) → its first word replaced from `two` through the
#      instruction bus → 1, 2.
#   2. SRAM1 through the data bus: `three` (movi a2, 3) copied into SRAM1, which the
#      instruction bus sees word-inverted (instruction word 0x400BF000 + 4k is data word
#      0x3FFE0FFC − 4k), called at 0x400BF000; its first word then replaced from `four`
#      through the data bus → 3, 4.
#   3. MMU: the test maps 0x400D0000 to flash page 1 (a copy of `five`) and puts `six` in flash
#      page 2; the program calls 0x400D0000, points PRO MMU entry 77 (0x3FF10134) at page 2 and
#      calls again → 5, 6.
#   4. Flash: `break 1, 14`; the test erases flash page 2's first sector and programs `seven`
#      there; the program calls 0x400D0000 (the model's cache keeps tags only, so a run without
#      the predecode cache already fetches the new bytes), sets DPORT_PRO_CACHE_CTRL FLUSH_ENA
#      (bit 4, what Cache_Flush does) and calls it again → 7, 7.
    .include "harness.inc"
    HARNESS_START
    RESULTS_START

    # 1. IRAM, rewritten through the instruction bus.
    call0 patch
    RESULT a2
    movi a3, two
    movi a4, patch
    l32i a5, a3, 0
    s32i a5, a4, 0
    call0 patch
    RESULT a2

    # 2. SRAM1, written through the data bus, run through the instruction bus.
    movi a3, three
    movi a4, 0x3FFE0FFC
    l32i a5, a3, 0
    s32i a5, a4, 0
    l32i a5, a3, 4
    addi a4, a4, -4
    s32i a5, a4, 0
    movi a6, 0x400BF000
    callx0 a6
    RESULT a2
    movi a3, four
    movi a4, 0x3FFE0FFC
    l32i a5, a3, 0
    s32i a5, a4, 0
    callx0 a6
    RESULT a2

    # 3. An MMU remap of the executed IROM page.
    movi a6, 0x400D0000
    callx0 a6
    RESULT a2
    movi a3, 0x3FF10134
    movi a4, 2
    s32i a4, a3, 0
    callx0 a6
    RESULT a2

    # 4. Flash erased and programmed by the test, then Cache_Flush.
    break 1, 14
    callx0 a6
    RESULT a2
    movi a3, 0x3FF00040
    l32i a4, a3, 0
    movi a5, 0x10
    or a4, a4, a5
    s32i a4, a3, 0
    callx0 a6
    RESULT a2
    HARNESS_END

# The functions: `movi a2, n; ret` in their 3-byte forms (no-transform keeps the assembler from
# narrowing them), each word-aligned, so word 0 holds the movi and ret's first byte and word 1
# the rest of ret — the SRAM1 copy moves two words, which land in reverse order in its data view.
    .begin no-transform
    .align 4
    .global patch
patch:
    movi a2, 1
    ret
    .align 4
two:
    movi a2, 2
    ret
    .align 4
three:
    movi a2, 3
    ret
    .align 4
four:
    movi a2, 4
    ret
    .align 4
    .global five
five:
    movi a2, 5
    ret
    .align 4
    .global six
six:
    movi a2, 6
    ret
    .align 4
    .global seven
seven:
    movi a2, 7
    ret
    .end no-transform
