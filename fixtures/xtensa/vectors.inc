# vectors.inc — minimal exception and interrupt vectors for the BT29 test programs, written from
# the Xtensa ISA RM's description of what each handler must do (not taken from ESP-IDF or the
# ROM). Use VECTORS instead of HARNESS_START:
#
#   _start: j to main; the literal pool; at 0x40080400 (= VECBASE, 1 KB aligned) the vectors at
#   their ESP32 offsets; stubs for unexpected events; then main: a1 = STACK_TOP, VECBASE set,
#   MISC0–MISC3 = 0, and a pseudo caller SP (STACK_TOP + 0x100) stored at [a1 − 12] so the
#   outermost frame can be spilled like any other. The program continues after the macro.
#
# Window overflow (0x00/0x80/0x100) and underflow (0x40/0xC0/0x140) handlers spill and refill a
# frame of 4, 8 or 12 registers: a0–a3 in the base save area 16 bytes below the callee's SP
# (a5/a9/a13 in the rotated window), a4–a11 in the extra save area below the frame's caller's SP
# (read from [a1 − 12]). Overflows count in MISC0 and underflows in MISC1, using registers that
# are already saved (overflow) or about to be reloaded (underflow).
#
# So a windowed function's frame (ENTRY's size) holds 16 bytes for its caller's caller's base save
# area plus its own extra save area: entry 16 in a function that makes call4s, 32 with call8,
# 48 with call12.
#
# Every other vector jumps to the label the program names in the VECTORS arguments; by default
# to a stub that halts (`break 1, 15`) with a2 = 0xE000 + the vector offset.

    .macro VECTORS user=.Lunexpected_user, kernel=.Lunexpected_kernel, double=.Lunexpected_double, level2=.Lunexpected_level2, level3=.Lunexpected_level3, level4=.Lunexpected_level4, level5=.Lunexpected_level5, debug=.Lunexpected_debug, nmi=.Lunexpected_nmi
    .text
    .global _start
    .align 4
_start:
    j .Lvectors_main
    .literal_position

    .begin no-transform
    .org 0x400 + 0x00
_WindowOverflow4:
    s32e a0, a5, -16
    s32e a1, a5, -12
    s32e a2, a5, -8
    s32e a3, a5, -4
    rsr a0, misc0
    addi a0, a0, 1
    wsr a0, misc0
    rfwo

    .org 0x400 + 0x40
_WindowUnderflow4:
    rsr a0, misc1
    addi a0, a0, 1
    wsr a0, misc1
    l32e a0, a5, -16
    l32e a1, a5, -12
    l32e a2, a5, -8
    l32e a3, a5, -4
    rfwu

    .org 0x400 + 0x80
_WindowOverflow8:
    s32e a0, a9, -16
    l32e a0, a1, -12
    s32e a1, a9, -12
    s32e a2, a9, -8
    s32e a3, a9, -4
    s32e a4, a0, -32
    s32e a5, a0, -28
    s32e a6, a0, -24
    s32e a7, a0, -20
    rsr a0, misc0
    addi a0, a0, 1
    wsr a0, misc0
    rfwo

    .org 0x400 + 0xC0
_WindowUnderflow8:
    rsr a0, misc1
    addi a0, a0, 1
    wsr a0, misc1
    l32e a1, a9, -12
    l32e a0, a9, -16
    l32e a7, a1, -12
    l32e a2, a9, -8
    l32e a4, a7, -32
    l32e a3, a9, -4
    l32e a5, a7, -28
    l32e a6, a7, -24
    l32e a7, a7, -20
    rfwu

    .org 0x400 + 0x100
_WindowOverflow12:
    s32e a0, a13, -16
    l32e a0, a1, -12
    s32e a1, a13, -12
    s32e a2, a13, -8
    s32e a3, a13, -4
    s32e a4, a0, -48
    s32e a5, a0, -44
    s32e a6, a0, -40
    s32e a7, a0, -36
    s32e a8, a0, -32
    s32e a9, a0, -28
    s32e a10, a0, -24
    s32e a11, a0, -20
    rsr a0, misc0
    addi a0, a0, 1
    wsr a0, misc0
    rfwo

    .org 0x400 + 0x140
_WindowUnderflow12:
    rsr a0, misc1
    addi a0, a0, 1
    wsr a0, misc1
    l32e a1, a13, -12
    l32e a0, a13, -16
    l32e a11, a1, -12
    l32e a2, a13, -8
    l32e a4, a11, -48
    l32e a8, a11, -32
    l32e a3, a13, -4
    l32e a5, a11, -44
    l32e a6, a11, -40
    l32e a7, a11, -36
    l32e a9, a11, -28
    l32e a10, a11, -24
    l32e a11, a11, -20
    rfwu
    .end no-transform

    .org 0x400 + 0x180
    j \level2
    .org 0x400 + 0x1C0
    j \level3
    .org 0x400 + 0x200
    j \level4
    .org 0x400 + 0x240
    j \level5
    .org 0x400 + 0x280
    j \debug
    .org 0x400 + 0x2C0
    j \nmi
    .org 0x400 + 0x300
    j \kernel
    .org 0x400 + 0x340
    j \user
    .org 0x400 + 0x3C0
    j \double

    .org 0x800
.Lunexpected_level2:
    movi a2, 0xE180
    break 1, 15
.Lunexpected_level3:
    movi a2, 0xE1C0
    break 1, 15
.Lunexpected_level4:
    movi a2, 0xE200
    break 1, 15
.Lunexpected_level5:
    movi a2, 0xE240
    break 1, 15
.Lunexpected_debug:
    movi a2, 0xE280
    break 1, 15
.Lunexpected_nmi:
    movi a2, 0xE2C0
    break 1, 15
.Lunexpected_kernel:
    movi a2, 0xE300
    break 1, 15
.Lunexpected_user:
    movi a2, 0xE340
    break 1, 15
.Lunexpected_double:
    movi a2, 0xE3C0
    break 1, 15

    .align 4
.Lvectors_main:
    movi a1, STACK_TOP
    movi a2, 0x40080400
    wsr a2, vecbase
    movi a2, 0
    wsr a2, misc0
    wsr a2, misc1
    wsr a2, misc2
    wsr a2, misc3
    movi a2, STACK_TOP + 0x100
    addi a3, a1, -12
    s32i a2, a3, 0
    .endm
