# l32r.S — L32R loads literals at negative offsets: from the harness pool before the code, and
# from a second pool the code jumps over, so later loads reach back across it. Results:
#   0x01234567 · 0x89abcdef · 0xffffffff · 0x00000000 (first pool), then 0xdeadbeef ·
#   0x0badf00d (second pool), then the first pool again from after the second: 0x01234567
    .include "harness.inc"
    HARNESS_START
    RESULTS_START
    .literal .Lv1, 0x01234567
    .literal .Lv2, 0x89abcdef
    .literal .Lv3, 0xffffffff
    .literal .Lv4, 0x00000000
    l32r a4, .Lv1
    RESULT a4
    l32r a4, .Lv2
    RESULT a4
    l32r a4, .Lv3
    RESULT a4
    l32r a4, .Lv4
    RESULT a4
    j .Lafter
    .literal_position
    .literal .Lv5, 0xdeadbeef
    .literal .Lv6, 0x0badf00d
    .align 4
.Lafter:
    l32r a4, .Lv5
    RESULT a4
    l32r a4, .Lv6
    RESULT a4
    l32r a4, .Lv1
    RESULT a4
    HARNESS_END
